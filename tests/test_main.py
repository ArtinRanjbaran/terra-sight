import asyncio
from io import BytesIO
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi import UploadFile
from pydantic import SecretStr
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

from backend.app import analysis
from backend.app.main import (
    EarthdataTokenRequest,
    app,
    configure_earthdata,
    forget_earthdata,
    require_local_ui_request,
)


def test_earthdata_auth_routes_are_registered_once() -> None:
    for method in {"POST", "DELETE"}:
        assert sum(
            route.path == "/api/auth/earthdata" and method in route.methods
            for route in app.routes
        ) == 1


def local_request(
    host: str = "127.0.0.1",
    origin: str = "http://127.0.0.1:5173",
) -> SimpleNamespace:
    return SimpleNamespace(
        client=SimpleNamespace(host=host),
        headers={"origin": origin},
    )


def test_earthdata_token_can_only_be_configured_from_local_ui() -> None:
    require_local_ui_request(local_request())

    with pytest.raises(HTTPException) as error:
        require_local_ui_request(local_request(host="192.0.2.1"))
    assert error.value.status_code == 403

    with pytest.raises(HTTPException) as error:
        require_local_ui_request(local_request(origin="https://example.com"))
    assert error.value.status_code == 403


def test_local_token_is_held_in_memory_and_can_be_forgotten(monkeypatch) -> None:
    monkeypatch.delenv("EARTHDATA_TOKEN", raising=False)
    analysis.clear_earthdata_token()
    request = local_request()
    try:
        configured = asyncio.run(
            configure_earthdata(
                request,
                EarthdataTokenRequest(token=SecretStr("  local-test-token  ")),
            )
        )
        assert configured == {"earthdata_token_configured": True}
        assert analysis.get_earthdata_token() == "local-test-token"

        forgotten = asyncio.run(forget_earthdata(request))
        assert forgotten == {"earthdata_token_configured": False}
        assert analysis.get_earthdata_token() is None
    finally:
        analysis.clear_earthdata_token()


def _geotiff_upload(values: np.ndarray) -> UploadFile:
    with MemoryFile() as memory_file:
        with memory_file.open(
            driver="GTiff",
            height=values.shape[0],
            width=values.shape[1],
            count=1,
            dtype="float32",
            crs="EPSG:4326",
            transform=from_origin(-1, 1, 0.0625, 0.0625),
            nodata=-9999,
        ) as dataset:
            dataset.write(values.astype("float32"), 1)
        return UploadFile(
            filename="local.tif",
            file=BytesIO(memory_file.read()),
        )


def test_local_upload_route_analyzes_without_earthdata_token(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.delenv("EARTHDATA_TOKEN", raising=False)
    monkeypatch.setattr(analysis, "OUTPUT_ROOT", tmp_path / "results")
    analysis.clear_earthdata_token()

    before = _geotiff_upload(np.full((16, 16), 0.1, dtype="float32"))
    after = _geotiff_upload(np.full((16, 16), 0.2, dtype="float32"))

    async def upload_pair() -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(
                app=app,
                client=("127.0.0.1", 50000),
            ),
            base_url="http://127.0.0.1",
        ) as client:
            return await client.post(
                "/api/analysis/local-backscatter",
                files={
                    "before_file": ("before.tif", before.file.read(), "image/tiff"),
                    "after_file": ("after.tif", after.file.read(), "image/tiff"),
                },
                data={
                    "units": "linear_gamma0",
                    "polarization": "VV",
                    "west": "-1",
                    "south": "0",
                    "east": "0",
                    "north": "1",
                },
                headers={"origin": "http://127.0.0.1:5173"},
            )

    response = asyncio.run(upload_pair())

    assert response.status_code == 200, response.text
    result = response.json()
    assert analysis.get_earthdata_token() is None
    assert result["analysis_source"] == "local_geotiff_upload"
    assert result["statistics"]["valid_pixels"] == 256
    assert (tmp_path / "results" / result["preview_url"].rsplit("/", 1)[-1]).exists()


def test_unexpected_catalog_failure_returns_actionable_error_and_is_logged(
    monkeypatch,
    caplog,
) -> None:
    import backend.app.main as main_module

    async def fail_search(**_kwargs):
        raise RuntimeError("synthetic parser failure")

    monkeypatch.setattr(main_module, "search_rtc_scenes", fail_search)

    async def request_catalog() -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            return await client.get(
                "/api/catalog/search",
                params={
                    "west": -17,
                    "south": 64,
                    "east": -16,
                    "north": 65,
                    "start_date": "2025-01-01",
                    "end_date": "2025-12-31",
                },
            )

    response = asyncio.run(request_catalog())

    assert response.status_code == 500
    assert "Check the backend terminal" in response.json()["detail"]
    assert "Unexpected NASA CMR catalog search failure" in caplog.text
    assert "synthetic parser failure" in caplog.text
