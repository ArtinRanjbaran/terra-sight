from pathlib import Path

import httpx
import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.transform import from_origin

import backend.app.analysis as analysis
from backend.app.analysis import (
    EarthdataAuthenticationRequired,
    IncompatibleProducts,
    _fetch_checksum,
    _derive_delta_db,
    _quality_valid_mask,
    _source_is_db,
    _summarize_change_cells,
    _summarize_statistics,
    _to_db,
    _validate_matching_grids,
    _validate_pair_metadata,
    _validate_time_series_metadata,
    _process_time_series,
    _write_pair_comparison_previews,
    run_local_backscatter_analysis,
)


def test_linear_gamma0_is_converted_to_decibels_before_subtraction() -> None:
    before = np.array([[0.1, 0.25, 1.0]], dtype=np.float32)
    after = before * 2
    delta, valid = _derive_delta_db(
        before,
        after,
        np.ones(before.shape, dtype=bool),
        before_stored_as_db=False,
        after_stored_as_db=False,
    )

    assert valid.all()
    np.testing.assert_allclose(delta, 10 * np.log10(2), rtol=1e-5)


def test_invalid_nonpositive_backscatter_is_excluded() -> None:
    before = np.array([[0.1, 0.0, np.nan]], dtype=np.float32)
    after = np.array([[0.2, 0.5, 0.3]], dtype=np.float32)
    delta, valid = _derive_delta_db(
        before,
        after,
        np.ones(before.shape, dtype=bool),
        before_stored_as_db=False,
        after_stored_as_db=False,
    )

    assert valid.tolist() == [[True, False, False]]
    assert delta[0, 0] == pytest.approx(10 * np.log10(2), rel=1e-5)
    assert np.isnan(delta[0, 1:]).all()


def test_already_db_values_are_subtracted_without_second_conversion() -> None:
    before = np.array([[-14.0, -6.0]], dtype=np.float32)
    after = np.array([[-12.0, -9.0]], dtype=np.float32)
    delta, valid = _derive_delta_db(
        before,
        after,
        np.ones(before.shape, dtype=bool),
        before_stored_as_db=True,
        after_stored_as_db=True,
    )

    assert valid.all()
    np.testing.assert_allclose(delta, [[2.0, -3.0]])
    np.testing.assert_allclose(_to_db(before, stored_as_db=True), before)


def test_mismatched_arrays_are_rejected() -> None:
    with pytest.raises(IncompatibleProducts, match="matching dimensions"):
        _derive_delta_db(
            np.ones((2, 2)),
            np.ones((2, 3)),
            np.ones((2, 2), dtype=bool),
            False,
            False,
        )


def test_only_unmasked_opera_class_zero_pixels_are_retained() -> None:
    pixels = np.array([[0.5, 0.6, 0.7, 0.8, 0.9]], dtype=np.float32)
    flags = np.array([[0, 1, 2, 3, 255]], dtype=np.uint8)
    valid = _quality_valid_mask(
        pixels,
        flags,
        np.array([[False, False, False, False, False]]),
        np.array([[False, False, False, False, False]]),
    )

    assert valid.tolist() == [[True, False, False, False, False]]


def test_rasters_must_share_crs_transform_and_dimensions() -> None:
    grid = {
        "crs": "EPSG:32628",
        "transform": (30, 0, 0, 0, -30, 0),
        "width": 4,
        "height": 5,
    }
    _validate_matching_grids(grid, dict(grid))
    with pytest.raises(IncompatibleProducts, match="identical grid"):
        _validate_matching_grids(grid, {**grid, "width": 3})


def _write_local_gamma0(
    path: Path,
    values: np.ndarray,
    transform=from_origin(-1, 1, 0.0625, 0.0625),
) -> None:
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=values.shape[0],
        width=values.shape[1],
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=transform,
        nodata=-9999,
    ) as destination:
        destination.write(values.astype("float32"), 1)


def test_local_upload_analysis_is_grid_checked_and_discloses_unverified_source(
    tmp_path: Path,
    monkeypatch,
) -> None:
    before = np.full((16, 16), 0.1, dtype="float32")
    after = np.full((16, 16), 0.2, dtype="float32")
    before[0, 0] = -9999
    after[0, 1] = -9999
    before_path = tmp_path / "before.tif"
    after_path = tmp_path / "after.tif"
    _write_local_gamma0(before_path, before)
    _write_local_gamma0(after_path, after)
    monkeypatch.setattr(analysis, "OUTPUT_ROOT", tmp_path / "results")

    result = run_local_backscatter_analysis(
        before_path,
        after_path,
        "VV",
        "linear_gamma0",
        (-1, 0, 0, 1),
        "2025-01-02",
        "2025-02-03",
    )

    assert result["analysis_source"] == "local_geotiff_upload"
    assert result["before"]["acquired_at"] == "2025-01-02"
    assert result["after"]["acquired_at"] == "2025-02-03"
    assert result["statistics"]["valid_pixels"] == 254
    assert result["statistics"]["median_delta_db"] == pytest.approx(
        10 * np.log10(2),
        rel=1e-5,
    )
    assert result["quality"]["mask_applied"] is False
    assert "not independently verified" in result["quality"]["provenance"]
    assert "not surface displacement" in " ".join(result["limitations"])
    assert (tmp_path / "results" / result["geotiff_url"].rsplit("/", 1)[-1]).exists()


def test_local_upload_analysis_rejects_mismatched_pixel_grids(tmp_path: Path) -> None:
    values = np.full((16, 16), 0.1, dtype="float32")
    before_path = tmp_path / "before.tif"
    after_path = tmp_path / "after.tif"
    _write_local_gamma0(before_path, values)
    _write_local_gamma0(after_path, values, from_origin(-0.9, 1, 0.0625, 0.0625))

    with pytest.raises(IncompatibleProducts, match="identical grid"):
        run_local_backscatter_analysis(
            before_path,
            after_path,
            "VV",
            "linear_gamma0",
            (-1, 0, 0, 1),
        )


@pytest.mark.parametrize("status_code", [401, 403])
def test_checksum_auth_failure_reports_status_and_next_steps(
    monkeypatch,
    status_code: int,
) -> None:
    real_client = httpx.Client
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(status_code=status_code)
    )
    monkeypatch.setattr(
        analysis.httpx,
        "Client",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )

    with pytest.raises(EarthdataAuthenticationRequired) as error:
        _fetch_checksum(
            "https://cumulus.asf.earthdatacloud.nasa.gov/OPERA/"
            "OPERA_L2_RTC-S1/test.tif.md5",
            "not-a-real-token",
        )

    assert f"HTTP {status_code}" in str(error.value)
    assert "Earthdata token is current" in str(error.value)


def test_checksum_redirect_forwards_bearer_only_to_earthdata_hosts(
    monkeypatch,
) -> None:
    token = "local-test-token"
    checksum = "a1" * 16
    authorization_by_host: dict[str, str | None] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        authorization_by_host[host] = request.headers.get("Authorization")
        if host == analysis.PRODUCT_HOST:
            return httpx.Response(
                302,
                headers={"Location": "https://urs.earthdata.nasa.gov/login"},
            )
        if host == analysis.EARTHDATA_LOGIN_HOST:
            return httpx.Response(
                302,
                headers={"Location": "https://download.example.test/checksum"},
            )
        return httpx.Response(200, text=f"{checksum}  product.tif")

    real_client = httpx.Client
    transport = httpx.MockTransport(handle)
    monkeypatch.setattr(
        analysis.httpx,
        "Client",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )

    result = _fetch_checksum(
        "https://cumulus.asf.earthdatacloud.nasa.gov/OPERA/"
        "OPERA_L2_RTC-S1/product.tif.md5",
        token,
    )

    assert result == checksum
    assert authorization_by_host[analysis.PRODUCT_HOST] == f"Bearer {token}"
    assert authorization_by_host[analysis.EARTHDATA_LOGIN_HOST] == f"Bearer {token}"
    assert authorization_by_host["download.example.test"] is None


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("subswath", 2, "subswath"),
        ("processing_version", "2.0", "processing versions"),
        ("orbit_direction", "DESCENDING", "orbit directions"),
    ],
)
def test_pair_metadata_rejects_incompatible_acquisitions(
    field: str,
    value: object,
    message: str,
) -> None:
    before = {
        "id": "G1-ASF",
        "acquired_at": "2025-01-01T10:00:00Z",
        "tile": "T009-017868",
        "acquisition_mode": "IW",
        "subswath": 1,
        "orbit_direction": "ASCENDING",
        "processing_version": "1.0",
        "polarizations": ["VV"],
        "assets": {"mask": "mask.tif"},
    }
    after = {
        **before,
        "id": "G2-ASF",
        "acquired_at": "2025-01-07T10:00:00Z",
        field: value,
    }

    with pytest.raises(IncompatibleProducts, match=message):
        _validate_pair_metadata(before, after, "VV")


def test_pair_metadata_allows_cross_platform_with_provenance_note() -> None:
    before = {
        "id": "G1-ASF",
        "acquired_at": "2025-01-01T10:00:00Z",
        "tile": "T009-017868",
        "acquisition_mode": "IW",
        "subswath": 1,
        "orbit_direction": None,
        "processing_version": "1.0",
        "platform": "S1A",
        "polarizations": ["VV"],
        "assets": {"mask": "mask.tif"},
    }
    after = {
        **before,
        "id": "G2-ASF",
        "acquired_at": "2025-01-07T10:00:00Z",
        "platform": "S1C",
    }

    _validate_pair_metadata(before, after, "VV")


def test_change_grid_contains_only_valid_cells_with_geographic_bounds() -> None:
    difference = np.array([[-2.0, 3.0], [1.0, 5.0]], dtype=np.float32)
    valid = np.array([[True, False], [True, True]])
    cells = _summarize_change_cells(
        difference,
        valid,
        {
            "crs": "EPSG:4326",
            "transform": from_origin(-2, 3, 0.5, 0.5),
        },
    )

    assert len(cells) == 3
    assert cells[0]["bounds_wgs84"] == pytest.approx([-2, 2.5, -1.5, 3])
    assert cells[0]["median_delta_db"] == pytest.approx(-2)
    assert cells[0]["valid_pixel_fraction"] == 1


def test_statistics_report_descriptive_spread_and_valid_coverage() -> None:
    statistics = _summarize_statistics(np.array([-3.0, -1.0, 1.0, 3.0]), 8)

    assert statistics["mean_delta_db"] == pytest.approx(0)
    assert statistics["median_delta_db"] == pytest.approx(0)
    assert statistics["standard_deviation_db"] == pytest.approx(np.sqrt(5))
    assert statistics["minimum_delta_db"] == -3
    assert statistics["maximum_delta_db"] == 3
    assert statistics["valid_pixel_fraction"] == pytest.approx(0.5)


def test_comparison_previews_share_a_stretch_and_mask(tmp_path) -> None:
    before = np.array([[1.0, 2.0], [4.0, 8.0]], dtype=np.float32)
    after = before * 2
    valid = np.array([[True, True], [True, False]])
    before_name, after_name, stretch = _write_pair_comparison_previews(
        before,
        after,
        valid,
        False,
        False,
        "G1-ASF",
        "G2-ASF",
        "VV",
        tmp_path,
    )

    with Image.open(tmp_path / before_name) as before_preview:
        before_pixels = np.asarray(before_preview)
    with Image.open(tmp_path / after_name) as after_preview:
        after_pixels = np.asarray(after_preview)

    assert stretch[0] < stretch[1]
    assert before_pixels.shape == after_pixels.shape == (2, 2, 4)
    assert before_pixels[1, 1, 3] == after_pixels[1, 1, 3] == 0
    assert before_pixels[0, 0, 0] < after_pixels[0, 0, 0]


def test_conversion_uses_raster_declared_opera_equation(tmp_path) -> None:
    raster_path = tmp_path / "linear.tif"
    with rasterio.open(
        raster_path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="float32",
        crs="EPSG:32628",
        transform=from_origin(0, 60, 30, 30),
    ) as raster:
        raster.update_tags(
            PROCESSING_INFORMATION_OUTPUT_BACKSCATTER_DECIBEL_CONVERSION_EQUATION="10 * log10(x)"
        )
        assert _source_is_db(raster) is False


def test_missing_conversion_metadata_is_rejected(tmp_path) -> None:
    raster_path = tmp_path / "unknown.tif"
    with rasterio.open(
        raster_path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="float32",
        crs="EPSG:32628",
        transform=from_origin(0, 60, 30, 30),
    ) as raster:
        with pytest.raises(IncompatibleProducts, match="conversion equation"):
            _source_is_db(raster)


def _time_series_scenes() -> list[dict]:
    dates = [
        "2025-01-01T10:00:00.000Z",
        "2025-01-07T10:00:00.000Z",
        "2025-01-13T10:00:00.000Z",
    ]
    return [
        {
            "id": f"G{index}-ASF",
            "product_id": f"OPERA_RTC_{index}",
            "acquired_at": acquired_at,
            "platform": "S1A",
            "tile": "T009-017868",
            "acquisition_mode": "IW",
            "subswath": 1,
            "relative_track": 9,
            "orbit_number": 100 + index,
            "orbit_direction": "ASCENDING",
            "processing_version": "1.0",
            "polarizations": ["VV", "VH"],
            "assets": {
                "VV": f"https://example.test/{index}_VV.tif",
                "VV_md5": f"https://example.test/{index}_VV.tif.md5",
                "mask": f"https://example.test/{index}_mask.tif",
                "mask_md5": f"https://example.test/{index}_mask.tif.md5",
            },
            "source_url": f"https://cmr.example.test/{index}",
        }
        for index, acquired_at in enumerate(dates, start=1)
    ]


def test_time_series_requires_distinct_dates_and_compatible_granules() -> None:
    scenes = _time_series_scenes()
    _validate_time_series_metadata(scenes, "VV")

    repeated_date = [*scenes]
    repeated_date[2] = {**repeated_date[2], "acquired_at": scenes[1]["acquired_at"]}
    with pytest.raises(IncompatibleProducts, match="one compatible acquisition per UTC date"):
        _validate_time_series_metadata(repeated_date, "VV")

    mismatched_tile = [*scenes]
    mismatched_tile[2] = {**mismatched_tile[2], "tile": "T010-017868"}
    with pytest.raises(IncompatibleProducts, match="same OPERA RTC-S1 burst tile"):
        _validate_time_series_metadata(mismatched_tile, "VV")


def test_pair_metadata_rejects_same_day_duplicate_granules() -> None:
    scene = _time_series_scenes()[0]
    same_day = {**scene, "id": "G99-ASF", "product_id": "OPERA_RTC_99"}
    with pytest.raises(IncompatibleProducts, match="different UTC dates"):
        _validate_pair_metadata(scene, same_day, "VV")


def test_time_series_summarizes_each_date_on_the_same_quality_screened_pixels(
    monkeypatch,
) -> None:
    scenes = _time_series_scenes()
    scene_values = {
        scene["id"]: np.full((20, 20), -12.0 + index * 2, dtype=np.float32)
        for index, scene in enumerate(scenes)
    }
    valid_masks = {
        scene["id"]: np.ones((20, 20), dtype=bool)
        for scene in scenes
    }
    valid_masks[scenes[0]["id"]][0, :] = False
    valid_masks[scenes[1]["id"]][:, 0] = False
    transform = from_origin(0, 600, 30, 30)

    def read_window(raster_path, _mask_path, _bounds):
        scene_id = raster_path.stem
        valid = valid_masks[scene_id]
        metadata = {
            "crs": "EPSG:32628",
            "transform": transform,
            "width": 20,
            "height": 20,
            "stored_as_db": True,
            "valid_pixels": int(valid.sum()),
            "mask_classes": {"0": int(valid.sum()), "1": 20},
        }
        return scene_values[scene_id], valid, metadata

    monkeypatch.setenv("EARTHDATA_TOKEN", "test-token")
    monkeypatch.setattr(
        "backend.app.analysis._download_product",
        lambda scene, _polarization, _token: Path(f"{scene['id']}.tif"),
    )
    monkeypatch.setattr(
        "backend.app.analysis._download_mask",
        lambda scene, _token: Path(f"{scene['id']}_mask.tif"),
    )
    monkeypatch.setattr("backend.app.analysis._read_masked_window", read_window)

    result = _process_time_series(
        scenes,
        "VV",
        (-17.0, 64.0, -16.0, 65.0),
    )

    assert result["classification"] == "DERIVED"
    assert [item["median_backscatter_db"] for item in result["observations"]] == [
        -12.0,
        -10.0,
        -8.0,
    ]
    assert result["coverage"]["common_valid_pixels"] == 19 * 19
    assert result["quality"]["statistics_use_same_common_pixels"] is True
    assert all(
        item["common_valid_pixels"] == 19 * 19
        for item in result["observations"]
    )
