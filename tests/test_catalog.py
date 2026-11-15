import asyncio
from datetime import date
from unittest.mock import AsyncMock, patch

import httpx

from backend.app.catalog import parse_granule, search_rtc_scenes


def _record() -> dict:
    product = (
        "OPERA_L2_RTC-S1_T009-017868-IW1_20251207T074201Z_"
        "20251207T094255Z_S1A_30_v1.0"
    )
    base = (
        "https://cumulus.asf.earthdatacloud.nasa.gov/OPERA/OPERA_L2_RTC-S1/"
        f"{product}/{product}"
    )
    return {
        "id": "G3901250596-ASF",
        "producer_granule_id": product,
        "dataset_id": "OPERA RTC-S1 test collection",
        "time_start": "2025-12-07T07:42:01.000Z",
        "time_end": "2025-12-07T07:42:04.000Z",
        "orbit_calculated_spatial_domains": [{"orbit_number": "62206"}],
        "orbit_direction": "Ascending",
        "granule_size": "13.47",
        "coordinate_system": "CARTESIAN",
        "polygons": [["65.0614 -15.40728 65.23778 -17.20754 64.89908 -15.50489 65.0614 -15.40728"]],
        "links": [
            {"href": base + "_VV.tif", "title": "VV"},
            {"href": base + "_VH.tif", "title": "VH"},
            {"href": base + "_mask.tif", "title": "Mask"},
            {"href": base + "_VV.tif.md5", "title": "VV checksum"},
            {"href": base + "_BROWSE_thumbnail.png", "title": "Browse"},
            {"href": base + "_BROWSE_low-res.png", "title": "Higher-resolution browse"},
            {"href": "s3://bucket/private.tif", "title": "S3 mirror"},
        ],
    }


def test_parse_granule_preserves_source_metadata_and_geometry() -> None:
    scene = parse_granule(_record())

    assert scene is not None
    assert scene["id"] == "G3901250596-ASF"
    assert scene["platform"] == "S1A"
    assert scene["tile"] == "T009-017868"
    assert scene["relative_track"] == 9
    assert scene["mode"] == "IW1"
    assert scene["acquisition_mode"] == "IW"
    assert scene["subswath"] == 1
    assert scene["processing_version"] == "1.0"
    assert scene["orbit_number"] == 62206
    assert scene["orbit_direction"] == "ASCENDING"
    assert scene["polarizations"] == ["VV", "VH"]
    assert scene["assets"]["VV"].endswith("_VV.tif")
    assert scene["assets"]["VV_md5"].endswith("_VV.tif.md5")
    assert scene["assets"]["browse"].endswith("_BROWSE_low-res.png")
    assert scene["geometry"]["type"] == "Polygon"
    assert scene["geometry"]["coordinates"][0][0] == [-15.40728, 65.0614]


def test_parse_granule_rejects_non_opera_entries() -> None:
    assert parse_granule({"title": "S1A_IW_GRDH_UNRELATED"}) is None


def test_search_filters_acquisition_mode_and_subswath_independently() -> None:
    first = _record()
    second = _record()
    second["producer_granule_id"] = second["producer_granule_id"].replace(
        "-IW1_", "-IW2_"
    )

    async def search() -> dict:
        with patch("backend.app.catalog.httpx.AsyncClient") as client_factory:
            client = client_factory.return_value.__aenter__.return_value
            client.get = AsyncMock(
                return_value=httpx.Response(
                    200,
                    json={"feed": {"entry": [first, second]}},
                    request=httpx.Request("GET", "https://cmr.example.test"),
                )
            )
            return await search_rtc_scenes(
                west=-17,
                south=64,
                east=-16,
                north=65,
                start_date=date(2025, 12, 7),
                end_date=date(2025, 12, 13),
                platform=None,
                polarization=None,
                relative_track=None,
                acquisition_mode="IW",
                subswath=2,
            )

    result = asyncio.run(search())

    assert [scene["acquisition_mode"] for scene in result["scenes"]] == ["IW"]
    assert [scene["subswath"] for scene in result["scenes"]] == [2]


def test_search_filters_orbit_direction_only_from_reported_metadata() -> None:
    ascending = _record()
    descending = _record()
    descending["id"] = "G3901250597-ASF"
    descending["orbit_direction"] = "Descending"

    async def search() -> dict:
        with patch("backend.app.catalog.httpx.AsyncClient") as client_factory:
            client = client_factory.return_value.__aenter__.return_value
            client.get = AsyncMock(
                return_value=httpx.Response(
                    200,
                    json={"feed": {"entry": [ascending, descending]}},
                    request=httpx.Request("GET", "https://cmr.example.test"),
                )
            )
            return await search_rtc_scenes(
                west=-17,
                south=64,
                east=-16,
                north=65,
                start_date=date(2025, 12, 7),
                end_date=date(2025, 12, 13),
                platform=None,
                polarization=None,
                relative_track=None,
                orbit_direction="DESCENDING",
            )

    result = asyncio.run(search())

    assert [scene["orbit_direction"] for scene in result["scenes"]] == ["DESCENDING"]
    assert result["filters"]["orbit_direction"] == "DESCENDING"


def test_search_uses_cmr_search_after_to_return_all_pages() -> None:
    first = _record()
    second = _record()
    second["id"] = "G3901250597-ASF"
    second["producer_granule_id"] = second["producer_granule_id"].replace(
        "20251207", "20251213"
    ).replace("20251207T074201Z", "20251213T074201Z")
    second["time_start"] = "2025-12-13T07:42:01.000Z"
    first_response = httpx.Response(
        200,
        json={"feed": {"entry": [first]}},
        headers={"CMR-Hits": "2", "CMR-Search-After": '["next-page"]'},
        request=httpx.Request("GET", "https://cmr.example.test"),
    )
    second_response = httpx.Response(
        200,
        json={"feed": {"entry": [second]}},
        headers={"CMR-Hits": "2"},
        request=httpx.Request("GET", "https://cmr.example.test"),
    )

    async def search() -> tuple[dict, AsyncMock]:
        with patch("backend.app.catalog.httpx.AsyncClient") as client_factory:
            client = client_factory.return_value.__aenter__.return_value
            client.get = AsyncMock(side_effect=[first_response, second_response])
            result = await search_rtc_scenes(
                west=-17,
                south=64,
                east=-16,
                north=65,
                start_date=date(2025, 12, 7),
                end_date=date(2025, 12, 13),
                platform=None,
                polarization=None,
                relative_track=None,
            )
            return result, client.get

    result, get = asyncio.run(search())

    assert get.await_count == 2
    assert get.call_args_list[1].kwargs["headers"]["CMR-Search-After"] == '["next-page"]'
    assert result["count"] == 2
    assert result["cmr_total_hits"] == 2
    assert result["catalog_complete"] is True


def test_search_retries_a_transient_cmr_server_error() -> None:
    record = _record()
    request = httpx.Request("GET", "https://cmr.example.test")

    async def search() -> tuple[dict, AsyncMock]:
        with patch("backend.app.catalog.httpx.AsyncClient") as client_factory:
            client = client_factory.return_value.__aenter__.return_value
            client.get = AsyncMock(
                side_effect=[
                    httpx.Response(502, request=request),
                    httpx.Response(
                        200,
                        json={"feed": {"entry": [record]}},
                        request=request,
                    ),
                ]
            )
            result = await search_rtc_scenes(
                west=-17,
                south=64,
                east=-16,
                north=65,
                start_date=date(2025, 12, 7),
                end_date=date(2025, 12, 13),
                platform=None,
                polarization=None,
                relative_track=None,
                acquisition_mode=None,
                subswath=None,
            )
            return result, client.get

    result, get = asyncio.run(search())

    assert get.await_count == 2
    assert result["count"] == 1

