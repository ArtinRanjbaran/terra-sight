import asyncio
import ipaddress
import logging
import re
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, SecretStr

from .analysis import (
    AnalysisUnavailable,
    EarthdataAuthenticationRequired,
    IncompatibleProducts,
    OUTPUT_ROOT,
    clear_earthdata_token,
    get_earthdata_token,
    run_backscatter_analysis,
    run_backscatter_time_series,
    run_local_backscatter_analysis,
    set_earthdata_token,
)
from .catalog import CatalogUnavailable, search_rtc_scenes


app = FastAPI(
    title="TERRA SIGHT API",
    description="Live NASA CMR discovery and reproducible OPERA RTC-S1 backscatter analysis.",
    version="0.1.0",
)
logger = logging.getLogger(__name__)
LOCAL_UI_PORTS = {5173, 4173}
MAX_LOCAL_UPLOAD_BYTES = 100 * 1024 * 1024


class AnalysisRequest(BaseModel):
    before_id: str = Field(pattern=r"^G\d+-ASF$")
    after_id: str = Field(pattern=r"^G\d+-ASF$")
    polarization: Literal["VV", "VH"] = "VV"
    bounds: tuple[float, float, float, float] = Field(
        description="Study area bounds in WGS84 order: west, south, east, north."
    )


class TimeSeriesRequest(BaseModel):
    scene_ids: list[Annotated[str, Field(pattern=r"^G\d+-ASF$")]] = Field(
        min_length=3,
        max_length=6,
    )
    polarization: Literal["VV", "VH"] = "VV"
    bounds: tuple[float, float, float, float] = Field(
        description="Study area bounds in WGS84 order: west, south, east, north."
    )


class EarthdataTokenRequest(BaseModel):
    token: SecretStr


def require_local_ui_request(request: Request) -> None:
    client = request.client
    origin = request.headers.get("origin")
    if not client or not origin:
        raise HTTPException(
            status_code=403,
            detail="Earthdata credentials can only be configured from the local app.",
        )
    try:
        remote_address = ipaddress.ip_address(client.host)
        origin_url = urlsplit(origin)
        local_origin = (
            origin_url.scheme == "http"
            and origin_url.hostname in {"127.0.0.1", "localhost", "::1"}
            and origin_url.port in LOCAL_UI_PORTS
        )
    except ValueError:
        local_origin = False
        remote_address = None
    if not remote_address or not remote_address.is_loopback or not local_origin:
        raise HTTPException(
            status_code=403,
            detail="Earthdata credentials can only be configured from the local app.",
        )


@app.get("/api/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "catalog": "NASA CMR",
        "analysis": "OPERA RTC-S1 gamma0 backscatter difference",
        "earthdata_token_configured": bool(get_earthdata_token()),
    }


@app.post("/api/auth/earthdata")
async def configure_earthdata(
    request: Request,
    payload: EarthdataTokenRequest,
) -> dict[str, bool]:
    require_local_ui_request(request)
    token = payload.token.get_secret_value().strip()
    if not token or len(token) > 4096:
        raise HTTPException(
            status_code=422,
            detail="Enter a non-empty Earthdata token no longer than 4,096 characters.",
        )
    set_earthdata_token(token)
    return {"earthdata_token_configured": True}


@app.delete("/api/auth/earthdata")
async def forget_earthdata(request: Request) -> dict[str, bool]:
    require_local_ui_request(request)
    clear_earthdata_token()
    return {"earthdata_token_configured": False}


@app.get("/api/catalog/search")
async def catalog_search(
    west: Annotated[float, Query(ge=-180, le=180)],
    south: Annotated[float, Query(ge=-90, le=90)],
    east: Annotated[float, Query(ge=-180, le=180)],
    north: Annotated[float, Query(ge=-90, le=90)],
    start_date: date,
    end_date: date,
    platform: Literal["S1A", "S1B", "S1C"] | None = None,
    polarization: Literal["VV", "VH"] | None = None,
    acquisition_mode: Literal["IW", "EW", "SM", "WV"] | None = None,
    subswath: Annotated[int | None, Query(ge=1, le=3)] = None,
    orbit_direction: Literal["ASCENDING", "DESCENDING"] | None = None,
    relative_track: Annotated[int | None, Query(ge=1, le=175)] = None,
    page_size: Annotated[int, Query(ge=1, le=100)] = 100,
) -> dict[str, object]:
    if west >= east or south >= north:
        raise HTTPException(
            status_code=422,
            detail="Bounds must be ordered west < east and south < north.",
        )
    if east - west > 20 or north - south > 20:
        raise HTTPException(
            status_code=422,
            detail="Search areas are limited to 20 degrees per axis for this study tool.",
        )
    if start_date > end_date:
        raise HTTPException(status_code=422, detail="start_date must precede end_date.")
    if (end_date - start_date).days > 366:
        raise HTTPException(status_code=422, detail="Date windows may not exceed one year.")
    if subswath is not None and acquisition_mode not in {None, "IW", "EW"}:
        raise HTTPException(
            status_code=422,
            detail="Subswath filtering is available only for IW and EW acquisitions.",
        )

    try:
        return await search_rtc_scenes(
            west=west,
            south=south,
            east=east,
            north=north,
            start_date=start_date,
            end_date=end_date,
            platform=platform,
            polarization=polarization,
            relative_track=relative_track,
            acquisition_mode=acquisition_mode,
            subswath=subswath,
            orbit_direction=orbit_direction,
            page_size=page_size,
        )
    except CatalogUnavailable as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except Exception as error:
        # Keep unexpected parser/runtime failures visible in the backend terminal
        # while returning a useful, non-sensitive message to the browser.
        logger.exception("Unexpected NASA CMR catalog search failure")
        raise HTTPException(
            status_code=500,
            detail=(
                "The catalog service encountered an unexpected error. "
                "Check the backend terminal for details, then retry."
            ),
        ) from error


@app.post("/api/analysis/backscatter")
async def analyze_backscatter(request: AnalysisRequest) -> dict[str, object]:
    west, south, east, north = request.bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(
            status_code=422,
            detail="Bounds must be a non-empty WGS84 box: west, south, east, north.",
        )
    if east - west > 20 or north - south > 20:
        raise HTTPException(
            status_code=422,
            detail="Analysis area is limited to 20 degrees per axis.",
        )
    try:
        return await asyncio.to_thread(
            run_backscatter_analysis,
            request.before_id,
            request.after_id,
            request.polarization,
            request.bounds,
        )
    except EarthdataAuthenticationRequired as error:
        raise HTTPException(status_code=424, detail=str(error)) from error
    except IncompatibleProducts as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except AnalysisUnavailable as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Unexpected RTC backscatter analysis failure")
        raise HTTPException(
            status_code=500,
            detail="The RTC analysis failed. Check backend logs for details.",
        ) from error


async def _store_local_geotiff(upload: UploadFile, destination: Path) -> None:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in {".tif", ".tiff"}:
        raise HTTPException(status_code=415, detail="Choose a .tif or .tiff GeoTIFF file.")

    total_bytes = 0
    with destination.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            total_bytes += len(chunk)
            if total_bytes > MAX_LOCAL_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="Each local GeoTIFF must be 100 MiB or smaller.",
                )
            output.write(chunk)
    if total_bytes == 0:
        raise HTTPException(status_code=422, detail="The uploaded GeoTIFF is empty.")


@app.post("/api/analysis/local-backscatter")
async def analyze_local_backscatter(
    request: Request,
    before_file: UploadFile = File(...),
    after_file: UploadFile = File(...),
    units: Literal["linear_gamma0", "db_gamma0"] = Form(...),
    polarization: Literal["VV", "VH"] = Form("VV"),
    west: float = Form(...),
    south: float = Form(...),
    east: float = Form(...),
    north: float = Form(...),
    before_date: date | None = Form(None),
    after_date: date | None = Form(None),
) -> dict[str, object]:
    require_local_ui_request(request)
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(
            status_code=422,
            detail="Bounds must be a non-empty WGS84 box: west, south, east, north.",
        )
    if east - west > 20 or north - south > 20:
        raise HTTPException(
            status_code=422,
            detail="Analysis area is limited to 20 degrees per axis.",
        )

    try:
        with TemporaryDirectory(prefix="terra-sight-upload-") as directory:
            before_path = Path(directory) / "before.tif"
            after_path = Path(directory) / "after.tif"
            await _store_local_geotiff(before_file, before_path)
            await _store_local_geotiff(after_file, after_path)
            return await asyncio.to_thread(
                run_local_backscatter_analysis,
                before_path,
                after_path,
                polarization,
                units,
                (west, south, east, north),
                before_date.isoformat() if before_date else None,
                after_date.isoformat() if after_date else None,
            )
    except IncompatibleProducts as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except AnalysisUnavailable as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Unexpected local GeoTIFF analysis failure")
        raise HTTPException(
            status_code=500,
            detail="The local GeoTIFF analysis failed. Check backend logs for details.",
        ) from error
    finally:
        await before_file.close()
        await after_file.close()


@app.post("/api/analysis/backscatter-timeseries")
async def analyze_backscatter_time_series(
    request: TimeSeriesRequest,
) -> dict[str, object]:
    west, south, east, north = request.bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(
            status_code=422,
            detail="Bounds must be a non-empty WGS84 box: west, south, east, north.",
        )
    if east - west > 20 or north - south > 20:
        raise HTTPException(
            status_code=422,
            detail="Analysis area is limited to 20 degrees per axis.",
        )
    try:
        return await asyncio.to_thread(
            run_backscatter_time_series,
            request.scene_ids,
            request.polarization,
            request.bounds,
        )
    except EarthdataAuthenticationRequired as error:
        raise HTTPException(status_code=424, detail=str(error)) from error
    except IncompatibleProducts as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except AnalysisUnavailable as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except Exception as error:
        logger.exception("Unexpected RTC backscatter time-series failure")
        raise HTTPException(
            status_code=500,
            detail="The RTC time-series analysis failed. Check backend logs for details.",
        ) from error


@app.get("/api/analysis/results/{filename}")
async def analysis_result(filename: str) -> FileResponse:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.(?:png|tif)", filename):
        raise HTTPException(status_code=404, detail="Analysis result not found.")
    path = (OUTPUT_ROOT / filename).resolve()
    if path.parent != OUTPUT_ROOT.resolve() or not path.is_file():
        raise HTTPException(status_code=404, detail="Analysis result not found.")
    media_type = "image/png" if path.suffix == ".png" else "image/tiff"
    return FileResponse(path, media_type=media_type, filename=filename)
