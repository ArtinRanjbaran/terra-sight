from contextlib import contextmanager
import hashlib
import math
import os
import re
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urljoin, urlparse
from uuid import uuid4

import httpx
import numpy as np
import rasterio
from PIL import Image, __version__ as pillow_version
from rasterio.enums import Resampling
from rasterio.transform import array_bounds
from rasterio.warp import transform as transform_coordinates
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

from .catalog import CatalogUnavailable, get_rtc_granule


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CACHE_ROOT = PROJECT_ROOT / "data" / "cache"
OUTPUT_ROOT = CACHE_ROOT / "results"
PRODUCT_HOST = "cumulus.asf.earthdatacloud.nasa.gov"
EARTHDATA_LOGIN_HOST = "urs.earthdata.nasa.gov"
MAX_PRODUCT_BYTES = 100 * 1024 * 1024
MAX_ANALYSIS_PIXELS = 4_000_000
MAX_CHANGE_GRID_SIDE = 32
MAX_TIME_SERIES_SCENES = 6
PRODUCT_SPEC_URL = (
    "https://cumulus.asf.earthdatacloud.nasa.gov/PUBLIC/DATA/OPERA/"
    "ProductSpec_RTC-S1.pdf"
)
_runtime_earthdata_token: str | None = None


def set_earthdata_token(token: str) -> None:
    global _runtime_earthdata_token
    _runtime_earthdata_token = token


def clear_earthdata_token() -> None:
    global _runtime_earthdata_token
    _runtime_earthdata_token = None
    os.environ.pop("EARTHDATA_TOKEN", None)


def get_earthdata_token() -> str | None:
    return _runtime_earthdata_token or os.environ.get("EARTHDATA_TOKEN")


class AnalysisUnavailable(RuntimeError):
    pass


class EarthdataAuthenticationRequired(AnalysisUnavailable):
    pass


class IncompatibleProducts(AnalysisUnavailable):
    pass


def _product_file_path(concept_id: str, layer: str) -> Path:
    if not re.fullmatch(r"G\d+-ASF", concept_id):
        raise IncompatibleProducts("Invalid NASA CMR concept identifier.")
    if layer not in {"VV", "VH", "mask"}:
        raise IncompatibleProducts("Unsupported OPERA RTC-S1 raster layer.")
    return CACHE_ROOT / f"{concept_id}_{layer}.tif"


def _validated_asset_url(url: str, *, checksum: bool = False) -> None:
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != PRODUCT_HOST
        or not parsed.path.startswith("/OPERA/OPERA_L2_RTC-S1/")
        or not parsed.path.endswith(".tif.md5" if checksum else ".tif")
    ):
        raise IncompatibleProducts("CMR returned an unsupported raster asset URL.")


@contextmanager
def _earthdata_response(
    url: str,
    token: str,
    timeout: httpx.Timeout,
) -> Iterator[httpx.Response]:
    trusted_auth_hosts = {PRODUCT_HOST, EARTHDATA_LOGIN_HOST}
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        current_url = url
        response: httpx.Response | None = None
        for _ in range(10):
            parsed_url = urlparse(current_url)
            if parsed_url.scheme != "https" or not parsed_url.hostname:
                raise IncompatibleProducts(
                    "NASA returned an unsupported raster redirect URL."
                )
            headers = (
                {"Authorization": f"Bearer {token}"}
                if parsed_url.hostname in trusted_auth_hosts
                else {}
            )
            request = client.build_request("GET", current_url, headers=headers)
            response = client.send(request, stream=True)
            if response.status_code not in {301, 302, 303, 307, 308}:
                break
            location = response.headers.get("location")
            response.close()
            if not location:
                raise AnalysisUnavailable(
                    "NASA returned a redirect without a destination."
                )
            current_url = urljoin(current_url, location)
        else:
            raise AnalysisUnavailable("NASA returned too many asset redirects.")

        if response is None:
            raise AnalysisUnavailable("NASA did not return a source response.")
        try:
            yield response
        finally:
            response.close()


def _fetch_checksum(url: str, token: str) -> str:
    _validated_asset_url(url, checksum=True)
    try:
        with _earthdata_response(
            url,
            token,
            httpx.Timeout(30, connect=15),
        ) as response:
            if response.status_code in {401, 403}:
                raise EarthdataAuthenticationRequired(
                    f"Earthdata Login denied the source checksum "
                    f"(HTTP {response.status_code}). "
                    "Confirm the Earthdata token is current and has access to "
                    "this ASF-hosted OPERA product."
                )
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as error:
                raise AnalysisUnavailable(
                    f"The NASA checksum service returned HTTP "
                    f"{error.response.status_code}."
                ) from error
            response.read()
            match = re.search(r"\b([a-fA-F0-9]{32})\b", response.text)
    except httpx.HTTPError as error:
        raise AnalysisUnavailable(f"Could not retrieve the source checksum: {error}") from error
    if not match:
        raise AnalysisUnavailable("The NASA source checksum has an unsupported format.")
    return match.group(1).lower()


def _file_md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _cached_asset_matches(path: Path, checksum_url: str, token: str) -> bool:
    expected_checksum = _fetch_checksum(checksum_url, token)
    if _file_md5(path) == expected_checksum:
        return True
    path.unlink(missing_ok=True)
    return False


def _fetch_asset(
    url: str,
    destination: Path,
    token: str,
    checksum_url: str,
) -> Path:
    _validated_asset_url(url)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = destination.with_suffix(".part")
    digest = hashlib.md5()
    total = 0
    expected_checksum = _fetch_checksum(checksum_url, token)

    try:
        with _earthdata_response(
            url,
            token,
            httpx.Timeout(90, connect=20),
        ) as response:
            if response.status_code in {401, 403}:
                raise EarthdataAuthenticationRequired(
                    f"Earthdata Login denied this OPERA raster (HTTP {response.status_code}). "
                    "The token may be expired, malformed, or not authorized for this "
                    "ASF-hosted OPERA product. Generate a fresh Earthdata Login token "
                    "and confirm your account can access the source data."
                )
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as error:
                raise AnalysisUnavailable(
                    f"The OPERA raster service returned HTTP {error.response.status_code}."
                ) from error
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_PRODUCT_BYTES:
                raise AnalysisUnavailable(
                    "OPERA raster exceeds the local download size limit."
                )
            with temporary_path.open("wb") as output:
                for chunk in response.iter_bytes(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_PRODUCT_BYTES:
                        raise AnalysisUnavailable(
                            "OPERA raster exceeded the local download size limit."
                        )
                    digest.update(chunk)
                    output.write(chunk)
        if total == 0:
            raise AnalysisUnavailable("The OPERA raster download was empty.")
        if digest.hexdigest() != expected_checksum:
            raise AnalysisUnavailable(
                f"The downloaded product checksum did not match the NASA source record: "
                f"{destination.name}."
            )
        os.replace(temporary_path, destination)
    except EarthdataAuthenticationRequired:
        temporary_path.unlink(missing_ok=True)
        raise
    except (httpx.HTTPError, OSError, AnalysisUnavailable):
        temporary_path.unlink(missing_ok=True)
        raise
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return destination


def _download_product(
    scene: dict[str, Any],
    polarization: str,
    token: str,
    layer: str | None = None,
) -> Path:
    layer = layer or polarization
    asset_url = scene["assets"].get(polarization)
    if not asset_url:
        raise IncompatibleProducts(
            f"CMR granule {scene['id']} has no {polarization} GeoTIFF asset."
        )
    checksum_url = scene["assets"].get(f"{layer}_md5")
    if not checksum_url:
        raise IncompatibleProducts(
            f"CMR granule {scene['id']} has no NASA checksum for its {layer} raster."
        )
    destination = _product_file_path(scene["id"], polarization)
    if (
        destination.exists()
        and destination.stat().st_size
        and _cached_asset_matches(destination, checksum_url, token)
    ):
        return destination
    return _fetch_asset(asset_url, destination, token, checksum_url)


def _download_mask(scene: dict[str, Any], token: str) -> Path:
    asset_url = scene["assets"].get("mask")
    if not asset_url:
        raise IncompatibleProducts(
            f"CMR granule {scene['id']} has no RTC layover/shadow mask."
        )
    destination = _product_file_path(scene["id"], "mask")
    checksum_url = scene["assets"].get("mask_md5")
    if not checksum_url:
        raise IncompatibleProducts(
            f"CMR granule {scene['id']} has no NASA checksum for its mask raster."
        )
    if (
        destination.exists()
        and destination.stat().st_size
        and _cached_asset_matches(destination, checksum_url, token)
    ):
        return destination
    return _fetch_asset(asset_url, destination, token, checksum_url)


def _source_is_db(dataset: rasterio.DatasetReader) -> bool:
    tags = {key.lower(): value.lower() for key, value in dataset.tags().items()}
    tags.update(
        {key.lower(): value.lower() for key, value in dataset.tags(1).items()}
    )
    units = (dataset.units[0] or "").lower() if dataset.units else ""
    if units in {"db", "decibel", "decibels"}:
        return True
    equation = next(
        (
            value.strip().lower()
            for key, value in tags.items()
            if key.endswith("output_backscatter_decibel_conversion_equation")
        ),
        "",
    )
    normalized_equation = re.sub(r"[\s*(){}]", "", equation)
    if re.match(r"^10(?:\.0)?log10", normalized_equation):
        return False
    if normalized_equation in {"x", "identity"}:
        return True
    raise IncompatibleProducts(
        "The RTC GeoTIFF does not declare a supported backscatter-to-decibel "
        "conversion equation; the values cannot be interpreted safely."
    )


def _quality_valid_mask(
    pixels: np.ndarray,
    flags: np.ndarray,
    pixels_masked: np.ndarray,
    flags_masked: np.ndarray,
) -> np.ndarray:
    return (
        ~pixels_masked
        & ~flags_masked
        & (flags == 0)
        & np.isfinite(pixels)
    )


def _validate_matching_grids(
    before: dict[str, Any],
    after: dict[str, Any],
) -> None:
    if (
        before["crs"] != after["crs"]
        or before["transform"] != after["transform"]
        or before["width"] != after["width"]
        or before["height"] != after["height"]
    ):
        raise IncompatibleProducts(
            "The two gamma0 rasters do not share an identical grid; "
            "this workflow will not silently resample them."
        )


def _validate_pair_metadata(
    before: dict[str, Any],
    after: dict[str, Any],
    polarization: str,
) -> None:
    if before["id"] == after["id"]:
        raise IncompatibleProducts("Select two different OPERA acquisitions.")
    if before["acquired_at"][:10] == after["acquired_at"][:10]:
        raise IncompatibleProducts(
            "Select observations from different UTC dates; same-day CMR granules "
            "do not establish temporal change in this workflow."
        )
    if (
        before["tile"] != after["tile"]
        or before["acquisition_mode"] != after["acquisition_mode"]
        or before["subswath"] != after["subswath"]
    ):
        raise IncompatibleProducts(
            "Select observations from the same OPERA RTC-S1 burst tile, "
            "acquisition mode, and subswath."
        )
    if (
        before["orbit_direction"]
        and after["orbit_direction"]
        and before["orbit_direction"] != after["orbit_direction"]
    ):
        raise IncompatibleProducts(
            "Selected observations have different orbit directions."
        )
    if (
        before["processing_version"]
        and after["processing_version"]
        and before["processing_version"] != after["processing_version"]
    ):
        raise IncompatibleProducts(
            "Selected observations have different RTC processing versions."
        )
    if (
        polarization not in before["polarizations"]
        or polarization not in after["polarizations"]
    ):
        raise IncompatibleProducts(
            f"Both granules must contain a {polarization} polarization asset."
        )
    if "mask" not in before["assets"] or "mask" not in after["assets"]:
        raise IncompatibleProducts(
            "Both granules require their OPERA layover/shadow mask assets."
        )


def _validate_time_series_metadata(
    scenes: list[dict[str, Any]],
    polarization: str,
) -> None:
    if not 3 <= len(scenes) <= MAX_TIME_SERIES_SCENES:
        raise IncompatibleProducts(
            f"Choose between 3 and {MAX_TIME_SERIES_SCENES} observations for a temporal profile."
        )
    if len({scene["id"] for scene in scenes}) != len(scenes):
        raise IncompatibleProducts("A temporal profile cannot repeat an acquisition.")
    if len({scene["acquired_at"][:10] for scene in scenes}) != len(scenes):
        raise IncompatibleProducts(
            "Choose one compatible acquisition per UTC date for a temporal profile."
        )
    first = scenes[0]
    for scene in scenes[1:]:
        _validate_pair_metadata(first, scene, polarization)


def _read_masked_window(
    raster_path: Path,
    mask_path: Path,
    bounds_wgs84: tuple[float, float, float, float],
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    with rasterio.open(raster_path) as raster, rasterio.open(mask_path) as quality:
        if raster.crs is None or quality.crs is None:
            raise IncompatibleProducts("Raster or mask is missing its CRS.")
        if (
            raster.crs != quality.crs
            or raster.transform != quality.transform
            or raster.width != quality.width
            or raster.height != quality.height
        ):
            raise IncompatibleProducts(
                "RTC imagery and its layover/shadow mask are not on the same grid."
            )

        projected_bounds = transform_bounds(
            "EPSG:4326",
            raster.crs,
            *bounds_wgs84,
            densify_pts=21,
        )
        requested = from_bounds(*projected_bounds, transform=raster.transform)
        window = requested.round_offsets().round_lengths()
        window = window.intersection(
            rasterio.windows.Window(0, 0, raster.width, raster.height)
        )
        if window.width < 2 or window.height < 2:
            raise IncompatibleProducts(
                "The requested area does not overlap this OPERA RTC-S1 tile."
            )
        if window.width * window.height > MAX_ANALYSIS_PIXELS:
            raise IncompatibleProducts(
                "The requested area is too large for this local analysis. "
                "Select a smaller study area (at most four million pixels)."
            )

        pixels = raster.read(1, window=window, masked=True).astype("float32")
        flags = quality.read(1, window=window, masked=True)
        valid = _quality_valid_mask(
            np.asarray(pixels.data),
            np.asarray(flags.data),
            np.ma.getmaskarray(pixels),
            np.ma.getmaskarray(flags),
        )
        if int(valid.sum()) < 1:
            raise IncompatibleProducts(
                "The requested area contains no unmasked, valid OPERA pixels."
            )
        metadata = {
            "crs": raster.crs.to_string(),
            "transform": raster.window_transform(window),
            "width": int(window.width),
            "height": int(window.height),
            "nodata": raster.nodata,
            "stored_as_db": _source_is_db(raster),
            "raster_tags": raster.tags(),
            "valid_pixels": int(valid.sum()),
            "total_pixels": int(valid.size),
            "mask_classes": {
                str(int(value)): int(count)
                for value, count in zip(
                    *np.unique(np.asarray(flags.data)[~np.ma.getmaskarray(flags)], return_counts=True)
                )
            },
        }
        return np.asarray(pixels.data), valid, metadata


def _to_db(values: np.ndarray, stored_as_db: bool) -> np.ndarray:
    if stored_as_db:
        return values.astype("float32", copy=False)
    result = np.full(values.shape, np.nan, dtype="float32")
    positive = values > 0
    result[positive] = 10.0 * np.log10(values[positive])
    return result


def _derive_delta_db(
    before: np.ndarray,
    after: np.ndarray,
    valid: np.ndarray,
    before_stored_as_db: bool,
    after_stored_as_db: bool,
) -> tuple[np.ndarray, np.ndarray]:
    if before.shape != after.shape or before.shape != valid.shape:
        raise IncompatibleProducts("Raster arrays do not have matching dimensions.")
    before_db = _to_db(before, before_stored_as_db)
    after_db = _to_db(after, after_stored_as_db)
    valid = valid & np.isfinite(before_db) & np.isfinite(after_db)
    difference = np.full(before.shape, np.nan, dtype="float32")
    difference[valid] = after_db[valid] - before_db[valid]
    return difference, valid


def _summarize_change_cells(
    difference_db: np.ndarray,
    valid: np.ndarray,
    metadata: dict[str, Any],
) -> list[dict[str, Any]]:
    height, width = valid.shape
    cell_size = max(1, math.ceil(max(height, width) / MAX_CHANGE_GRID_SIDE))
    affine = metadata["transform"]
    cells: list[dict[str, Any]] = []

    for row_start in range(0, height, cell_size):
        row_end = min(row_start + cell_size, height)
        for column_start in range(0, width, cell_size):
            column_end = min(column_start + cell_size, width)
            cell_valid = valid[row_start:row_end, column_start:column_end]
            valid_pixels = int(cell_valid.sum())
            total_pixels = int(cell_valid.size)
            if not valid_pixels:
                continue

            corners = [
                affine * (column_start, row_start),
                affine * (column_end, row_start),
                affine * (column_end, row_end),
                affine * (column_start, row_end),
            ]
            longitudes, latitudes = transform_coordinates(
                metadata["crs"],
                "EPSG:4326",
                [point[0] for point in corners],
                [point[1] for point in corners],
            )
            values = difference_db[row_start:row_end, column_start:column_end][cell_valid]
            cells.append({
                "bounds_wgs84": [
                    min(longitudes),
                    min(latitudes),
                    max(longitudes),
                    max(latitudes),
                ],
                "median_delta_db": float(np.median(values)),
                "valid_pixels": valid_pixels,
                "total_pixels": total_pixels,
                "valid_pixel_fraction": valid_pixels / total_pixels,
            })

    return cells


def _summarize_statistics(
    values: np.ndarray,
    total_pixels: int,
) -> dict[str, float | int]:
    valid_pixels = int(values.size)
    if not valid_pixels or total_pixels < valid_pixels:
        raise IncompatibleProducts("No valid pixels remain for the change summary.")
    return {
        "mean_delta_db": float(np.mean(values)),
        "median_delta_db": float(np.median(values)),
        "standard_deviation_db": float(np.std(values)),
        "minimum_delta_db": float(np.min(values)),
        "maximum_delta_db": float(np.max(values)),
        "p10_delta_db": float(np.percentile(values, 10)),
        "p90_delta_db": float(np.percentile(values, 90)),
        "valid_pixels": valid_pixels,
        "total_pixels": total_pixels,
        "valid_pixel_fraction": valid_pixels / total_pixels,
    }


def _write_pair_comparison_previews(
    before: np.ndarray,
    after: np.ndarray,
    valid: np.ndarray,
    before_stored_as_db: bool,
    after_stored_as_db: bool,
    before_id: str,
    after_id: str,
    polarization: str,
    output_dir: Path = OUTPUT_ROOT,
) -> tuple[str, str, tuple[float, float]]:
    before_db = _to_db(before, before_stored_as_db)
    after_db = _to_db(after, after_stored_as_db)
    common_valid = valid & np.isfinite(before_db) & np.isfinite(after_db)
    combined_values = np.concatenate((before_db[common_valid], after_db[common_valid]))
    low, high = (float(value) for value in np.percentile(combined_values, [2, 98]))
    if high <= low:
        high = low + 1.0

    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{before_id}_{after_id}_{polarization}_shared_db"
    output_names = (f"{stem}_before.png", f"{stem}_after.png")
    for values, name in ((before_db, output_names[0]), (after_db, output_names[1])):
        normalized = np.zeros(values.shape, dtype="float32")
        normalized[common_valid] = np.clip(
            (values[common_valid] - low) / (high - low),
            0,
            1,
        )
        gray = (normalized * 255).astype("uint8")
        rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
        rgba[..., :3] = gray[..., None]
        rgba[..., 3][common_valid] = 235
        Image.fromarray(rgba, mode="RGBA").save(output_dir / name, optimize=True)
    return output_names[0], output_names[1], (low, high)


def _write_change_outputs(
    difference_db: np.ndarray,
    valid: np.ndarray,
    metadata: dict[str, Any],
    before_id: str,
    after_id: str,
    polarization: str,
    source_name: str = "NASA OPERA RTC-S1",
    processing_method: str = "OPERA RTC-S1 gamma0 backscatter difference",
) -> tuple[str, str]:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    stem = f"{before_id}_{after_id}_{polarization}_delta_gamma0_db"
    raster_path = OUTPUT_ROOT / f"{stem}.tif"
    preview_path = OUTPUT_ROOT / f"{stem}.png"

    nodata = -9999.0
    output = np.where(valid, difference_db, nodata).astype("float32")
    profile = {
        "driver": "GTiff",
        "height": metadata["height"],
        "width": metadata["width"],
        "count": 1,
        "dtype": "float32",
        "crs": metadata["crs"],
        "transform": metadata["transform"],
        "nodata": nodata,
        "compress": "deflate",
        "predictor": 3,
    }
    with rasterio.open(raster_path, "w", **profile) as destination:
        destination.write(output, 1)
        destination.set_band_description(1, "After-minus-before RTC gamma0 backscatter")
        destination.update_tags(
            AREA_OR_POINT="Area",
            classification="DERIVED",
            units="dB",
            equation="10*log10(after gamma0) - 10*log10(before gamma0)",
            before_source_id=before_id,
            after_source_id=after_id,
            data_source=source_name,
            polarization=polarization,
            processing_method=processing_method,
        )

    inlier_values = difference_db[valid]
    low, high = np.percentile(inlier_values, [2, 98])
    limit = max(abs(float(low)), abs(float(high)), 0.1)
    normalized = np.zeros(difference_db.shape, dtype="float32")
    normalized[valid] = np.clip(difference_db[valid] / limit, -1, 1)
    rgba = np.zeros((*difference_db.shape, 4), dtype=np.uint8)
    negative = normalized < 0
    positive = ~negative
    amount = np.abs(normalized)
    rgba[..., 0][negative] = (40 + 210 * amount[negative]).astype(np.uint8)
    rgba[..., 1][negative] = (145 - 100 * amount[negative]).astype(np.uint8)
    rgba[..., 2][negative] = (245 - 90 * amount[negative]).astype(np.uint8)
    rgba[..., 0][positive] = (35 + 220 * amount[positive]).astype(np.uint8)
    rgba[..., 1][positive] = (145 + 45 * amount[positive]).astype(np.uint8)
    rgba[..., 2][positive] = (235 - 205 * amount[positive]).astype(np.uint8)
    rgba[..., 3][valid] = 235
    Image.fromarray(rgba, mode="RGBA").save(preview_path, optimize=True)
    return raster_path.name, preview_path.name


def _process_pair(
    before: dict[str, Any],
    after: dict[str, Any],
    polarization: str,
    bounds: tuple[float, float, float, float],
) -> dict[str, Any]:
    token = get_earthdata_token()
    if not token:
        raise EarthdataAuthenticationRequired(
            "CMR metadata is public, but OPERA RTC-S1 raster downloads require "
            "Earthdata Login. Enter a token through the local-only session control "
            "or set it in the backend environment."
        )

    before_path = _download_product(before, polarization, token)
    after_path = _download_product(after, polarization, token)
    before_mask_path = _download_mask(before, token)
    after_mask_path = _download_mask(after, token)

    before_values, before_valid, before_meta = _read_masked_window(
        before_path, before_mask_path, bounds
    )
    after_values, after_valid, after_meta = _read_masked_window(
        after_path, after_mask_path, bounds
    )
    _validate_matching_grids(before_meta, after_meta)

    valid = before_valid & after_valid
    before_metadata = {
        "cmr_id": before["id"],
        "product_id": before["product_id"],
        "acquired_at": before["acquired_at"],
        "platform": before["platform"],
        "acquisition_mode": before["acquisition_mode"],
        "subswath": before["subswath"],
        "relative_track": before["relative_track"],
        "orbit_direction": before["orbit_direction"],
        "processing_version": before["processing_version"],
        "source_url": before["source_url"],
    }
    after_metadata = {
        "cmr_id": after["id"],
        "product_id": after["product_id"],
        "acquired_at": after["acquired_at"],
        "platform": after["platform"],
        "acquisition_mode": after["acquisition_mode"],
        "subswath": after["subswath"],
        "relative_track": after["relative_track"],
        "orbit_direction": after["orbit_direction"],
        "processing_version": after["processing_version"],
        "source_url": after["source_url"],
    }
    difference_db, valid = _derive_delta_db(
        before_values,
        after_values,
        valid,
        before_meta["stored_as_db"],
        after_meta["stored_as_db"],
    )
    valid_count = int(valid.sum())
    total_count = int(valid.size)
    if valid_count < 100:
        raise IncompatibleProducts(
            f"Only {valid_count} common quality-screened pixels remain; "
            "at least 100 are required for a useful summary."
        )

    values = difference_db[valid]
    if values.size < 100:
        raise IncompatibleProducts("Too few valid pixels remain after unit conversion.")

    raster_name, preview_name = _write_change_outputs(
        difference_db,
        valid,
        after_meta,
        before["id"],
        after["id"],
        polarization,
    )
    before_preview_name, after_preview_name, shared_stretch_db = (
        _write_pair_comparison_previews(
            before_values,
            after_values,
            valid,
            before_meta["stored_as_db"],
            after_meta["stored_as_db"],
            before["id"],
            after["id"],
            polarization,
        )
    )
    change_cells = _summarize_change_cells(difference_db, valid, after_meta)
    valid_fraction = valid_count / total_count
    cross_platform_warning = (
        "Acquisitions use different Sentinel-1 platforms; calibration and "
        "instrument differences may contribute to the observed backscatter change."
        if before["platform"] != after["platform"]
        else None
    )
    limitations = [
        "This is backscatter intensity change, not surface displacement or glacier velocity.",
        "Surface moisture, snow, melt, roughness, viewing geometry, residual registration error, and instrument differences can affect backscatter.",
        "OPERA RTC-S1 mask class 0 excludes flagged layover and shadow, but this summary is not a full uncertainty analysis.",
        "No causal event attribution is made.",
    ]
    if cross_platform_warning:
        limitations.append(cross_platform_warning)
    return {
        "classification": "DERIVED",
        "dataset": "OPERA RTC-S1 gamma0 backscatter",
        "before": before_metadata,
        "after": after_metadata,
        "method": (
            "For each matched pixel, convert RTC gamma0 backscatter to dB "
            "using 10*log10 and subtract before from after. Exclude NoData "
            "and OPERA RTC-S1 mask classes other than class 0."
        ),
        "polarization": polarization,
        "units": "dB change in gamma0 backscatter",
        "source_assets": {
            "before": {
                "backscatter": before["assets"][polarization],
                "backscatter_md5": before["assets"][f"{polarization}_md5"],
                "mask": before["assets"]["mask"],
                "mask_md5": before["assets"]["mask_md5"],
            },
            "after": {
                "backscatter": after["assets"][polarization],
                "backscatter_md5": after["assets"][f"{polarization}_md5"],
                "mask": after["assets"]["mask"],
                "mask_md5": after["assets"]["mask_md5"],
            },
        },
        "statistics": {
            **_summarize_statistics(values, total_count),
        },
        "coverage": {
            "requested_bounds_wgs84": list(bounds),
            "common_valid_pixel_fraction": valid_fraction,
        },
        "software": {
            "numpy": np.__version__,
            "rasterio": rasterio.__version__,
            "pillow": pillow_version,
        },
        "change_cells": change_cells,
        "quality": {
            "same_crs": before_meta["crs"] == after_meta["crs"],
            "same_affine_transform": before_meta["transform"] == after_meta["transform"],
            "same_dimensions": (
                before_meta["width"] == after_meta["width"]
                and before_meta["height"] == after_meta["height"]
            ),
            "same_platform": before["platform"] == after["platform"],
            "cross_platform_warning": cross_platform_warning,
            "mask_classes_retained": [0],
            "mask_class_counts_before": before_meta["mask_classes"],
            "mask_class_counts_after": after_meta["mask_classes"],
            "valid_pixel_fraction": valid_fraction,
            "uncertainty": (
                "No formal error budget is calculated. The p10-p90 interval "
                "describes spatial variation, not measurement uncertainty. "
                "Backscatter differences are not displacement."
            ),
        },
        "grid": {
            "crs": after_meta["crs"],
            "width": after_meta["width"],
            "height": after_meta["height"],
            "bounds": list(
                array_bounds(
                    after_meta["height"],
                    after_meta["width"],
                    after_meta["transform"],
                )
            ),
        },
        "preview_url": f"/api/analysis/results/{preview_name}",
        "comparison_previews": {
            "before_url": f"/api/analysis/results/{before_preview_name}",
            "after_url": f"/api/analysis/results/{after_preview_name}",
            "shared_db_stretch": list(shared_stretch_db),
            "valid_pixels_transparent": True,
            "same_grid_and_bounds": True,
        },
        "geotiff_url": f"/api/analysis/results/{raster_name}",
        "source_specification": PRODUCT_SPEC_URL,
        "limitations": limitations,
    }


def _read_local_raster_window(
    raster_path: Path,
    bounds_wgs84: tuple[float, float, float, float],
    stored_as_db: bool,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    with rasterio.open(raster_path) as raster:
        if raster.driver != "GTiff" or raster.count != 1:
            raise IncompatibleProducts(
                "Each local upload must be a single-band GeoTIFF."
            )
        if raster.crs is None:
            raise IncompatibleProducts("A local GeoTIFF is missing its CRS.")
        if raster.transform.b != 0 or raster.transform.d != 0:
            raise IncompatibleProducts(
                "Rotated GeoTIFF grids are not supported for local comparison."
            )

        projected_bounds = transform_bounds(
            "EPSG:4326",
            raster.crs,
            *bounds_wgs84,
            densify_pts=21,
        )
        requested = from_bounds(*projected_bounds, transform=raster.transform)
        window = requested.round_offsets().round_lengths().intersection(
            rasterio.windows.Window(0, 0, raster.width, raster.height)
        )
        if window.width < 2 or window.height < 2:
            raise IncompatibleProducts(
                "The selected WGS84 bounds do not overlap a local GeoTIFF."
            )
        if window.width * window.height > MAX_ANALYSIS_PIXELS:
            raise IncompatibleProducts(
                "The selected area exceeds four million pixels. Reduce the study bounds."
            )

        pixels = raster.read(1, window=window, masked=True).astype("float32")
        values = np.asarray(pixels.data)
        valid = ~np.ma.getmaskarray(pixels) & np.isfinite(values)
        metadata = {
            "crs": raster.crs.to_string(),
            "transform": raster.window_transform(window),
            "width": int(window.width),
            "height": int(window.height),
            "stored_as_db": stored_as_db,
            "valid_pixels": int(valid.sum()),
            "total_pixels": int(valid.size),
        }
        return values, valid, metadata


def run_local_backscatter_analysis(
    before_path: Path,
    after_path: Path,
    polarization: str,
    units: str,
    bounds: tuple[float, float, float, float],
    before_date: str | None = None,
    after_date: str | None = None,
) -> dict[str, Any]:
    if polarization not in {"VV", "VH"}:
        raise IncompatibleProducts("Choose VV or VH polarization.")
    if units not in {"linear_gamma0", "db_gamma0"}:
        raise IncompatibleProducts("Declare whether both GeoTIFFs contain linear gamma0 or dB.")

    stored_as_db = units == "db_gamma0"
    try:
        before_values, before_valid, before_meta = _read_local_raster_window(
            before_path, bounds, stored_as_db
        )
        after_values, after_valid, after_meta = _read_local_raster_window(
            after_path, bounds, stored_as_db
        )
    except rasterio.errors.RasterioError as error:
        raise IncompatibleProducts(
            "One or both uploads are not readable GeoTIFF rasters."
        ) from error
    _validate_matching_grids(before_meta, after_meta)
    valid = before_valid & after_valid
    difference_db, valid = _derive_delta_db(
        before_values,
        after_values,
        valid,
        stored_as_db,
        stored_as_db,
    )
    valid_count = int(valid.sum())
    total_count = int(valid.size)
    if valid_count < 100:
        raise IncompatibleProducts(
            f"Only {valid_count} common valid pixels remain; at least 100 are required."
        )

    run_id = uuid4().hex
    before_id = f"local_before_{run_id}"
    after_id = f"local_after_{run_id}"
    raster_name, preview_name = _write_change_outputs(
        difference_db,
        valid,
        after_meta,
        before_id,
        after_id,
        polarization,
        source_name="User-provided local GeoTIFFs",
        processing_method="User-provided gamma0 backscatter difference",
    )
    before_preview_name, after_preview_name, shared_stretch_db = (
        _write_pair_comparison_previews(
            before_values,
            after_values,
            valid,
            stored_as_db,
            stored_as_db,
            before_id,
            after_id,
            polarization,
        )
    )
    change_cells = _summarize_change_cells(difference_db, valid, after_meta)
    statistics = _summarize_statistics(difference_db[valid], total_count)
    before_metadata = {
        "cmr_id": None,
        "product_id": "User-provided local GeoTIFF (before)",
        "acquired_at": before_date,
        "platform": "User provided",
        "acquisition_mode": "Not reported",
        "subswath": None,
        "relative_track": None,
        "orbit_direction": None,
        "processing_version": "Not independently verified",
        "source_url": None,
    }
    after_metadata = {
        **before_metadata,
        "product_id": "User-provided local GeoTIFF (after)",
        "acquired_at": after_date,
    }
    limitations = [
        "The user supplied these rasters; their source, calibration, registration, and processing history are not independently verified.",
        "Both input files must be calibrated gamma0 backscatter with the user-declared units, the same polarization, and an identical pixel grid.",
        "Only NoData and non-finite pixels are excluded. No OPERA layover/shadow quality mask was supplied or applied.",
        "Backscatter intensity change is not surface displacement, glacier velocity, or causal attribution.",
        "No formal measurement-uncertainty budget is calculated.",
    ]
    return {
        "classification": "DERIVED",
        "analysis_source": "local_geotiff_upload",
        "dataset": "User-provided gamma0 GeoTIFF pair",
        "before": before_metadata,
        "after": after_metadata,
        "method": (
            f"Locally compare the user-provided, co-registered {units} gamma0 "
            "GeoTIFFs. Convert linear gamma0 to dB with 10*log10 when selected, "
            "then subtract before from after over common finite, non-NoData pixels. "
            "No OPERA quality mask or source checksum is applied."
        ),
        "polarization": polarization,
        "units": "dB change in gamma0 backscatter",
        "source_assets": None,
        "statistics": statistics,
        "coverage": {
            "requested_bounds_wgs84": list(bounds),
            "common_valid_pixel_fraction": valid_count / total_count,
        },
        "software": {
            "numpy": np.__version__,
            "rasterio": rasterio.__version__,
            "pillow": pillow_version,
        },
        "change_cells": change_cells,
        "quality": {
            "same_crs": before_meta["crs"] == after_meta["crs"],
            "same_affine_transform": before_meta["transform"] == after_meta["transform"],
            "same_dimensions": (
                before_meta["width"] == after_meta["width"]
                and before_meta["height"] == after_meta["height"]
            ),
            "mask_applied": False,
            "no_data_only_validity": True,
            "cross_platform_warning": None,
            "unit_declaration": units,
            "provenance": "User-provided; not independently verified.",
        },
        "grid": {
            "crs": after_meta["crs"],
            "width": after_meta["width"],
            "height": after_meta["height"],
            "bounds": list(
                array_bounds(
                    after_meta["height"],
                    after_meta["width"],
                    after_meta["transform"],
                )
            ),
        },
        "preview_url": f"/api/analysis/results/{preview_name}",
        "comparison_previews": {
            "before_url": f"/api/analysis/results/{before_preview_name}",
            "after_url": f"/api/analysis/results/{after_preview_name}",
            "shared_db_stretch": list(shared_stretch_db),
            "valid_pixels_transparent": True,
            "same_grid_and_bounds": True,
        },
        "geotiff_url": f"/api/analysis/results/{raster_name}",
        "source_specification": None,
        "limitations": limitations,
    }


def _process_time_series(
    scenes: list[dict[str, Any]],
    polarization: str,
    bounds: tuple[float, float, float, float],
) -> dict[str, Any]:
    token = get_earthdata_token()
    if not token:
        raise EarthdataAuthenticationRequired(
            "CMR metadata is public, but OPERA RTC-S1 raster downloads require "
            "Earthdata Login. Enter a token through the local-only session control "
            "or set it in the backend environment."
        )

    observations: list[dict[str, Any]] = []
    backscatter_db: list[np.ndarray] = []
    valid_masks: list[np.ndarray] = []
    metadata_rows: list[dict[str, Any]] = []
    source_assets: list[dict[str, Any]] = []

    for scene in scenes:
        raster_path = _download_product(scene, polarization, token)
        mask_path = _download_mask(scene, token)
        values, valid, metadata = _read_masked_window(
            raster_path, mask_path, bounds
        )
        if metadata_rows:
            _validate_matching_grids(metadata_rows[0], metadata)

        values_db = _to_db(values, metadata["stored_as_db"])
        valid = valid & np.isfinite(values_db)
        backscatter_db.append(values_db)
        valid_masks.append(valid)
        metadata_rows.append(metadata)
        source_assets.append({
            "backscatter": scene["assets"][polarization],
            "backscatter_md5": scene["assets"][f"{polarization}_md5"],
            "mask": scene["assets"]["mask"],
            "mask_md5": scene["assets"]["mask_md5"],
        })

    common_valid = np.logical_and.reduce(valid_masks)
    common_valid_pixels = int(common_valid.sum())
    total_pixels = int(common_valid.size)
    if common_valid_pixels < 100:
        raise IncompatibleProducts(
            f"Only {common_valid_pixels} pixels are valid across every selected date; "
            "at least 100 are required for a useful temporal profile."
        )

    for scene, values_db, metadata in zip(scenes, backscatter_db, metadata_rows):
        values = values_db[common_valid]
        observations.append({
            "cmr_id": scene["id"],
            "product_id": scene["product_id"],
            "acquired_at": scene["acquired_at"],
            "platform": scene["platform"],
            "tile": scene["tile"],
            "acquisition_mode": scene["acquisition_mode"],
            "subswath": scene["subswath"],
            "relative_track": scene["relative_track"],
            "orbit_number": scene["orbit_number"],
            "processing_version": scene["processing_version"],
            "source_url": scene["source_url"],
            "median_backscatter_db": float(np.median(values)),
            "mean_backscatter_db": float(np.mean(values)),
            "standard_deviation_db": float(np.std(values)),
            "p10_backscatter_db": float(np.percentile(values, 10)),
            "p90_backscatter_db": float(np.percentile(values, 90)),
            "common_valid_pixels": common_valid_pixels,
            "source_valid_pixels": metadata["valid_pixels"],
            "total_pixels": total_pixels,
        })

    platforms = sorted({scene["platform"] for scene in scenes})
    cross_platform_warning = (
        "The series includes multiple Sentinel-1 platforms; instrument and "
        "calibration differences may contribute to changes in the radar return."
        if len(platforms) > 1
        else None
    )
    return {
        "classification": "DERIVED",
        "dataset": "OPERA RTC-S1 gamma0 backscatter",
        "polarization": polarization,
        "units": "dB gamma0 backscatter",
        "observations": observations,
        "source_assets": source_assets,
        "coverage": {
            "requested_bounds_wgs84": list(bounds),
            "common_valid_pixels": common_valid_pixels,
            "total_pixels": total_pixels,
            "common_valid_pixel_fraction": common_valid_pixels / total_pixels,
        },
        "quality": {
            "same_grid": True,
            "mask_classes_retained": [0],
            "platforms": platforms,
            "cross_platform_warning": cross_platform_warning,
            "statistics_use_same_common_pixels": True,
            "uncertainty": (
                "The plotted median and spatial spread are descriptive, not a "
                "formal measurement-uncertainty estimate."
            ),
        },
        "software": {
            "numpy": np.__version__,
            "rasterio": rasterio.__version__,
            "pillow": pillow_version,
        },
        "method": (
            "Convert each selected RTC gamma0 raster to dB using its declared "
            "source units. Summarize each acquisition over the same pixels "
            "that are valid (mask class 0, non-NoData) on every selected date. "
            "No anomaly threshold or causal attribution is applied."
        ),
        "limitations": [
            "This is backscatter intensity, not displacement, glacier velocity, coherence, or InSAR.",
            "Moisture, snow, melt, roughness, viewing geometry, residual registration, and platform changes can affect the signal.",
            "The common mask improves spatial comparability but does not calculate formal measurement uncertainty.",
            "No causal event attribution or prediction is made.",
            *([cross_platform_warning] if cross_platform_warning else []),
        ],
        "source_specification": PRODUCT_SPEC_URL,
    }


def run_backscatter_analysis(
    before_id: str,
    after_id: str,
    polarization: str,
    bounds: tuple[float, float, float, float],
) -> dict[str, Any]:
    try:
        before = get_rtc_granule(before_id)
        after = get_rtc_granule(after_id)
    except CatalogUnavailable as error:
        raise AnalysisUnavailable(str(error)) from error

    _validate_pair_metadata(before, after, polarization)

    return _process_pair(before, after, polarization, bounds)


def run_backscatter_time_series(
    scene_ids: list[str],
    polarization: str,
    bounds: tuple[float, float, float, float],
) -> dict[str, Any]:
    try:
        scenes = [get_rtc_granule(scene_id) for scene_id in scene_ids]
    except CatalogUnavailable as error:
        raise AnalysisUnavailable(str(error)) from error

    scenes.sort(key=lambda scene: scene["acquired_at"])
    _validate_time_series_metadata(scenes, polarization)
    return _process_time_series(scenes, polarization, bounds)
