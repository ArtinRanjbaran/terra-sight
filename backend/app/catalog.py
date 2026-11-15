import asyncio
import re
from datetime import date
from typing import Any
from urllib.parse import urlencode

import httpx


CMR_BASE = "https://cmr.earthdata.nasa.gov/search"
COLLECTION = "OPERA_L2_RTC-S1_V1"
DATASET = "OPERA Radiometric Terrain Corrected SAR Backscatter from Sentinel-1 validated product (Version 1)"
CMR_PAGE_SIZE = 2000
MAX_CATALOG_RESULTS = 10_000


class CatalogUnavailable(RuntimeError):
    pass


def _assets(links: list[dict[str, Any]]) -> dict[str, str]:
    assets: dict[str, str] = {}
    browse_candidates: list[tuple[int, str]] = []

    for link in links:
        href = link.get("href", "")
        title = link.get("title", "")
        if not href.startswith("https://"):
            continue

        filename = href.rsplit("/", 1)[-1].lower()
        if filename.endswith("_vv.tif.md5"):
            assets["VV_md5"] = href
        elif filename.endswith("_vh.tif.md5"):
            assets["VH_md5"] = href
        elif filename.endswith("_mask.tif.md5"):
            assets["mask_md5"] = href
        elif filename.endswith("_vv.tif"):
            assets["VV"] = href
        elif filename.endswith("_vh.tif"):
            assets["VH"] = href
        elif filename.endswith("_mask.tif"):
            assets["mask"] = href
        elif "_browse_low-res.png" in filename:
            browse_candidates.append((0, href))
        elif "_browse_thumbnail.png" in filename:
            browse_candidates.append((1, href))
        elif "_browse.png" in filename:
            browse_candidates.append((2, href))
        elif title.lower().endswith(".png"):
            browse_candidates.append((3, href))

    if browse_candidates:
        assets["browse"] = min(browse_candidates)[1]
    return assets


def parse_granule(entry: dict[str, Any]) -> dict[str, Any] | None:
    product_id = entry.get("producer_granule_id") or entry.get("title") or ""
    if not product_id.startswith("OPERA_L2_RTC-S1_"):
        return None

    tile_match = re.search(r"_(T\d{3}-\d{6})-([A-Z]{2}\d)_", product_id)
    platform_match = re.search(r"_(S1[ABC])_\d+_v[\d.]+", product_id)
    if not tile_match or not platform_match:
        return None

    acquisition_mode = tile_match.group(2)[:-1]
    subswath = int(tile_match.group(2)[-1])
    processing_version_match = re.search(r"_v([\d.]+)$", product_id)
    links = _assets(entry.get("links", []))
    start_time = entry.get("time_start")
    if not start_time:
        return None

    raw_polygons = entry.get("polygons", [])
    rings: list[list[list[float]]] = []
    for polygon in raw_polygons:
        if not polygon:
            continue
        for ring in polygon:
            values = ring.split() if isinstance(ring, str) else ring
            try:
                coordinates = [float(value) for value in values]
            except (TypeError, ValueError):
                continue
            if len(coordinates) < 6 or len(coordinates) % 2:
                continue
            points = [
                [coordinates[index + 1], coordinates[index]]
                for index in range(0, len(coordinates), 2)
            ]
            if points[0] != points[-1]:
                points.append(points[0])
            rings.append(points)

    geometry = (
        {"type": "MultiPolygon", "coordinates": [[ring] for ring in rings]}
        if len(rings) > 1
        else {"type": "Polygon", "coordinates": rings}
    )

    return {
        "id": entry.get("id"),
        "product_id": product_id,
        "dataset": entry.get("dataset_id") or DATASET,
        "acquired_at": start_time,
        "end_time": entry.get("time_end"),
        "platform": platform_match.group(1),
        "instrument": "C-SAR",
        "mode": tile_match.group(2),
        "acquisition_mode": acquisition_mode,
        "subswath": subswath,
        "processing_version": (
            processing_version_match.group(1)
            if processing_version_match
            else None
        ),
        "tile": tile_match.group(1),
        "relative_track": int(tile_match.group(1)[1:4]),
        "orbit_number": _orbit_number(entry),
        "orbit_direction": (
            str(entry["orbit_direction"]).strip().upper()
            if entry.get("orbit_direction")
            else None
        ),
        "polarizations": [name for name in ("VV", "VH") if name in links],
        "assets": links,
        "geometry": geometry,
        "granule_size_mb": _float_or_none(entry.get("granule_size")),
        "source_url": f"{CMR_BASE}/granules.json?{urlencode({'concept_id': entry.get('id', '')})}",
        "collection": COLLECTION,
        "processing_level": "RTC-S1 v1",
        "coordinate_system": entry.get("coordinate_system"),
    }


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _orbit_number(entry: dict[str, Any]) -> int | None:
    domains = entry.get("orbit_calculated_spatial_domains") or []
    if not domains:
        return None
    try:
        return int(domains[0]["orbit_number"])
    except (KeyError, TypeError, ValueError):
        return None


def _polygon_strings(scene: dict[str, Any]) -> list[str]:
    coordinates = scene["geometry"]["coordinates"]
    polygons = coordinates if scene["geometry"]["type"] == "MultiPolygon" else [coordinates]
    result: list[str] = []
    for polygon in polygons:
        for ring in polygon:
            result.append(" ".join(f"{lat} {lon}" for lon, lat in ring))
    return result


def _catalog_url(
    west: float,
    south: float,
    east: float,
    north: float,
    start_date: date,
    end_date: date,
    page_size: int,
) -> str:
    query = {
        "short_name": COLLECTION,
        "bounding_box": f"{west},{south},{east},{north}",
        "temporal": (
            f"{start_date.isoformat()}T00:00:00Z,"
            f"{end_date.isoformat()}T23:59:59Z"
        ),
        "page_size": page_size,
    }
    return f"{CMR_BASE}/granules.json?{urlencode(query)}"


async def search_rtc_scenes(
    *,
    west: float,
    south: float,
    east: float,
    north: float,
    start_date: date,
    end_date: date,
    platform: str | None,
    polarization: str | None,
    relative_track: int | None,
    mode: str | None = None,
    acquisition_mode: str | None = None,
    subswath: int | None = None,
    orbit_direction: str | None = None,
    page_size: int = CMR_PAGE_SIZE,
) -> dict[str, Any]:
    url = _catalog_url(west, south, east, north, start_date, end_date, page_size)
    entries: list[dict[str, Any]] = []
    cmr_total_hits: int | None = None
    search_after: str | None = None
    catalog_complete = True
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            while len(entries) < MAX_CATALOG_RESULTS:
                headers = {"Accept": "application/json"}
                if search_after:
                    headers["CMR-Search-After"] = search_after

                for attempt in range(2):
                    try:
                        response = await client.get(url, headers=headers)
                        response.raise_for_status()
                        payload = response.json()
                        break
                    except httpx.HTTPStatusError as error:
                        retryable = error.response.status_code == 429 or error.response.status_code >= 500
                        if attempt == 0 and retryable:
                            await asyncio.sleep(0.5)
                            continue
                        raise CatalogUnavailable(
                            f"NASA CMR catalog request failed: {error}"
                        ) from error
                    except httpx.TransportError as error:
                        if attempt == 0:
                            await asyncio.sleep(0.5)
                            continue
                        raise CatalogUnavailable(
                            f"NASA CMR catalog request failed: {error}"
                        ) from error
                    except (httpx.HTTPError, ValueError) as error:
                        raise CatalogUnavailable(
                            f"NASA CMR catalog request failed: {error}"
                        ) from error

                if cmr_total_hits is None:
                    try:
                        cmr_total_hits = int(response.headers.get("CMR-Hits", ""))
                    except ValueError:
                        cmr_total_hits = None
                page_entries = payload.get("feed", {}).get("entry", [])
                if not page_entries:
                    break
                entries.extend(page_entries)
                search_after = response.headers.get("CMR-Search-After")
                if not search_after:
                    break
            else:
                catalog_complete = False

            if search_after and len(entries) >= MAX_CATALOG_RESULTS:
                catalog_complete = False
    except CatalogUnavailable:
        raise
    except (httpx.HTTPError, ValueError) as error:
        raise CatalogUnavailable(
            f"NASA CMR catalog request failed: {error}"
        ) from error

    unique_entries = {
        entry.get("id") or entry.get("producer_granule_id"): entry
        for entry in entries
    }
    entries = list(unique_entries.values())
    scenes = [scene for entry in entries if (scene := parse_granule(entry))]
    if platform:
        scenes = [scene for scene in scenes if scene["platform"] == platform]
    if polarization:
        scenes = [
            scene for scene in scenes if polarization in scene["polarizations"]
        ]
    if relative_track is not None:
        scenes = [
            scene for scene in scenes if scene["relative_track"] == relative_track
        ]
    if mode:
        scenes = [scene for scene in scenes if scene["mode"] == mode]
    if acquisition_mode:
        scenes = [
            scene for scene in scenes
            if scene["acquisition_mode"] == acquisition_mode
        ]
    if subswath is not None:
        scenes = [
            scene for scene in scenes
            if scene["acquisition_mode"] in {"IW", "EW"}
            and scene["subswath"] == subswath
        ]
    if orbit_direction:
        scenes = [
            scene for scene in scenes
            if scene["orbit_direction"] == orbit_direction
        ]

    scenes.sort(key=lambda scene: scene["acquired_at"])
    return {
        "source": "NASA CMR / Alaska Satellite Facility DAAC",
        "collection": COLLECTION,
        "catalog_url": url,
        "count": len(scenes),
        "cmr_total_hits": cmr_total_hits,
        "catalog_complete": catalog_complete,
        "scenes": scenes,
        "filters": {
            "bounds_wgs84": [west, south, east, north],
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "platform": platform,
            "polarization": polarization,
            "relative_track": relative_track,
            "acquisition_mode": acquisition_mode,
            "subswath": subswath,
            "orbit_direction": orbit_direction,
        },
    }


def get_rtc_granule(concept_id: str) -> dict[str, Any]:
    url = f"{CMR_BASE}/granules.json"
    try:
        response = httpx.get(
            url,
            params={
                "concept_id": concept_id,
                "short_name": COLLECTION,
                "page_size": 2,
            },
            headers={"Accept": "application/json"},
            timeout=30,
        )
        response.raise_for_status()
        entries = response.json().get("feed", {}).get("entry", [])
    except (httpx.HTTPError, ValueError) as error:
        raise CatalogUnavailable(f"NASA CMR granule lookup failed: {error}") from error

    if len(entries) != 1 or entries[0].get("id") != concept_id:
        raise CatalogUnavailable(
            f"CMR did not return one OPERA RTC-S1 granule for {concept_id}."
        )
    scene = parse_granule(entries[0])
    if scene is None:
        raise CatalogUnavailable(f"CMR granule {concept_id} is not an OPERA RTC-S1 scene.")
    return scene
