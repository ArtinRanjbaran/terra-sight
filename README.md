# TERRA SIGHT — See beyond the surface

NASA Space Apps Challenge 2026

An interactive Earth-observation platform for discovering, analyzing, and understanding surface change through satellite radar data. Its flagship investigation is **Dancing with the SARs**, with live NASA OPERA RTC-S1 data discovery, authenticated raster analysis, and an optional local GeoTIFF comparison that needs no Earthdata Login. Backscatter differences are not presented as ground motion.

## Run locally

Requirements: Node.js 20.19+ (or 22.12+) and Python 3.12.

The app uses the public NASA CMR catalog and public ASF browse previews without API keys. No third-party data API is required. Earthdata Login is optional: it is needed only to retrieve NASA's protected pixel-level RTC rasters. Alternatively, users can compare their own compatible GeoTIFF pair with the local Python processor; this does not verify the files' source or processing history.

1. From the project folder, install dependencies once.

   **Windows PowerShell**

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   npm install
   ```

   **macOS / Linux**

   ```sh
   python3.12 -m venv .venv
   .venv/bin/python -m pip install -r requirements.txt
   npm install
   ```

2. Start both the API and web app together:

   ```powershell
   npm start
   ```

   Open `http://127.0.0.1:5173`. Keep the terminal open; press Ctrl+C to stop services started by this command. Catalog discovery works without Earthdata credentials.

3. Optional: for local pixel analysis of authenticated rasters, create an Earthdata Login token. Select **Add Earthdata token for local analysis** or open **Evidence → Processing access**. The built-in Python processor runs on your computer; a token is used only to retrieve the real source rasters. On Windows, the hidden PowerShell prompt is also available:

   ```powershell
.\Start-TerraSight.ps1
   ```

The in-app password field sends the token only to the loopback API, keeps it in backend process memory, and clears the field after submission; the app does not save it to localStorage or source files. The credential endpoint rejects non-loopback clients and non-local origins. During product downloads, the backend forwards the Bearer token only to the ASF and Earthdata Login hosts in their authentication redirect; it does not send the token to external storage hosts. The PowerShell launcher passes the token only to the API process and clears it from the launcher session when the app exits. Never enter a token on a public deployment or include it in a screenshot. Use **Forget session token** to clear it from backend memory; stopping the API also clears it.

### No-login local GeoTIFF analysis

Open **Use local GeoTIFFs without Earthdata Login** in the processing panel and provide two single-band, georeferenced GeoTIFFs containing calibrated gamma0 backscatter on the same pixel grid. Declare whether both files are in linear gamma0 or dB; select their shared VV or VH polarization, optionally enter acquisition dates, and choose the WGS84 bounds to compare. Each input is limited to 100 MiB and the selected window to four million pixels. Files are held in temporary storage and removed after processing; only derived outputs and report metadata remain available.

This local path does not contact NASA, validate provenance or calibration, fetch source checksums, or apply OPERA layover/shadow masks. Only NoData and non-finite pixels are excluded. The result is a change in backscatter intensity, not displacement, and must not be presented as NASA-verified data. Keep the original rasters and their source documentation to reproduce the investigation.

The launcher reuses healthy local services, reports port conflicts, and surfaces missing Python or Node dependencies. Vite proxies `/api` requests to the local FastAPI server. The first raster download is capped at 100 MiB per file; verified files are cached under `data/cache/`. The backend binds to loopback for local use; it is not configured as a public production service. GitHub Pages can host only the static frontend and cannot run the required FastAPI catalog proxy or raster processor.

Do not open `index.html` directly with `file://`; the app uses JavaScript modules and Vite-resolved assets.

## If the catalog is unavailable

The API retries a transient NASA CMR network, rate-limit, or server error once. If the search still fails, the app offers **Retry search** and explains the failure. A browser message such as `Could not reach the application API` usually means the local services are stopped: run `npm start` from the project folder and reload `http://127.0.0.1:5173`. Failed searches clear old footprints so they cannot be mistaken for current coverage.

## Observatory workflow

- **Explore:** drag or zoom the textured globe; geographic graticule, selected study marker, and CMR footprints orient the investigation. Click the globe or keyboard-operable 2D context map to set the study center. The orbital path is schematic, not a satellite ephemeris.
- **Discover:** choose one of the built-in place presets or enter `latitude, longitude`, adjust WGS84 bounds and catalog filters, then query NASA CMR. The search defaults to the latest 12 months. CMR Search-After pagination retrieves up to 10,000 catalog hits; the interface shows 50 records per page and warns if a query exceeds that safety cap. Presets are not a geocoder and do not imply data coverage.
- **Compare:** after a catalog search, the app automatically selects the latest compatible same-platform pair (same tile, mode, subswath, distinct dates, and shared polarization); a cross-platform pair is a labeled fallback. The selected pair remains visible across pages. NASA CMR discovery and browse-preview comparison work without Earthdata credentials; the app prefers the 1024-pixel low-resolution preview over the 100-pixel thumbnail when available. Previews are not co-registered and do not support pixel-level conclusions. The local GeoTIFF path can perform quantitative backscatter comparison without Earthdata Login.
- **Temporal profile:** search a wider date range and build a VV or VH profile from 3–6 compatible acquisitions. The backend validates every CMR product, grid, unit declaration, and quality mask, then calculates each date's median backscatter over the same pixels valid in every acquisition. This requires `EARTHDATA_TOKEN`.
- **Change Detective:** run the authenticated RTC backscatter comparison or open the no-login local GeoTIFF workflow. OPERA results require checksum, grid, unit, and quality-mask checks; uploaded-file results require matching grids and are explicitly marked unverified, with no OPERA mask. Click a colored grid cell to inspect its WGS84 bounds, median dB change, and valid-pixel fraction.
- **Evidence:** inspect the methodology and limitations, open source records, export the current investigation as JSON, or save the study settings in this browser.
- **Reports:** save up to eight investigation snapshots locally, export portable JSON, or download a formatted HTML report. Reports distinguish live catalog metadata from a completed derived analysis.

Saved settings and report snapshots use browser `localStorage` on this device. HTML reports can be printed to PDF in the browser. Exports include loaded source metadata and clearly report when no derived raster result is available; they do not fabricate a comparison.

## Demonstration area and data

The initial search is centered on Vatnajökull, Iceland (WGS84 bounds -17, 64, -16, 65). NASA CMR's OPERA RTC-S1 collection is queried at runtime; acquisition records are not hard-coded as current observations. During initial data verification, the same burst tile `T009-017868-IW1` was found for:

- `G3901250596-ASF` — 2025-12-07, Sentinel-1A
- `G3914230863-ASF` — 2025-12-13, Sentinel-1C

The app queries the catalog again and only shows the records currently returned by CMR for the chosen area, dates, platform, polarization, and relative track. Product identifiers, UTC acquisition dates, source browse previews, and NASA CMR record links are retained in the interface and report.

Primary sources:

- [NASA CMR OPERA RTC-S1 collection](https://cmr.earthdata.nasa.gov/search/site/collections/C2777436413-ASF)
- [NASA OPERA project](https://www.earthdata.nasa.gov/data/projects/opera)
- [OPERA RTC-S1 Product Specification](https://cumulus.asf.earthdatacloud.nasa.gov/PUBLIC/DATA/OPERA/ProductSpec_RTC-S1.pdf)
- [NASA Alaska Satellite Facility DAAC](https://asf.alaska.edu/)
- [Earthdata Login](https://urs.earthdata.nasa.gov/)

## What the analysis calculates

For a two-date comparison, products must be from distinct UTC dates and share a burst tile, acquisition mode, subswath, compatible processing version, orbit direction (when reported), and polarization. The backend requires a valid token and:

1. Re-fetches each product's metadata from NASA CMR rather than trusting browser-supplied assets.
2. Downloads the selected polarization GeoTIFF and matching RTC mask, checking each file against the checksum linked by CMR.
3. Requires the pair to use an identical CRS, affine transform, and dimensions; it does not silently resample.
4. Reads only the requested WGS84 bounds, excludes NoData and mask classes other than class 0, and reads the GeoTIFF's declared decibel-conversion equation before converting values.
5. Computes after-minus-before gamma-zero backscatter in dB over common valid pixels and produces a tagged GeoTIFF plus a preview PNG.
6. Reports mean, median, standard deviation, minimum, maximum, spatial P10–P90, valid-pixel count/fraction, requested bounds, and a processing-software record.
7. Summarizes the derived pixel differences into at most a 32 × 32 geographic inspection grid. Each mapped cell carries its median Δγ⁰, WGS84 bounds, valid-pixel count, and valid fraction.

Results are marked **DERIVED**. Blue cells indicate lower and amber cells higher backscatter; shade scales to ±6 dB, while opacity reflects each cell's valid-pixel fraction. The descriptive standard deviation, extrema, P10–P90, and cell valid fraction are not measurement-uncertainty estimates. Cross-platform pairs are allowed only after structural checks and are explicitly caveated in the result. Raster download, units, and analysis failures are surfaced rather than replaced with simulated values.

The temporal profile endpoint accepts 3–6 unique UTC dates from one compatible tile/mode/subswath series. It reports per-date median, mean, spatial spread, and source identifiers over the intersection of valid pixels from all dates. This avoids changing the spatial sample between dates, but the result remains descriptive backscatter intensity—not displacement, an anomaly confidence score, or causal attribution. Mixed Sentinel platforms are explicitly flagged.

## Scientific limitations

- RTC gamma-zero backscatter change is an intensity comparison, **not** displacement, velocity, coherence, or an interferogram.
- Wetness, snow and melt, surface roughness, acquisition geometry, sensor differences, and residual geolocation error can affect backscatter.
- OPERA mask class 0 excludes flagged layover and shadow, but this processing is not a formal uncertainty budget or event-attribution method.
- InSAR requires suitable phase-preserving SLC observations, compatible geometry, and additional coherence and phase processing; this RTC workflow does not provide it.
- The textured Three.js Earth and graticule are cartographic context, not measured terrain or elevation. Stars are decorative. The schematic orbit is illustrative, not an actual satellite ephemeris. Study footprints, when present, come from CMR product geometry.
- The bundled cartographic texture is NASA Earth Observatory's *Blue Marble (2002), Land Surface, Shallow Water, and Shaded Topography*. It is not a scientific data layer or a live observation. NASA's [media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) describe reuse conditions; NASA attribution is provided below.
- OPERA GeoTIFF access requires Earthdata authentication. The separate user-upload workflow works without that login but does not confer NASA provenance or OPERA quality screening.

## License and attribution

Original project code is licensed under the [MIT License](./LICENSE). This permissive license allows reuse, modification, and redistribution as long as the copyright and license notice are retained; it provides the software without warranty.

The bundled Earth texture is a separate NASA asset and is **not covered by the MIT License**:

> NASA Earth Observatory, *The Blue Marble (2002): Land Surface, Shallow Water, and Shaded Topography*. [Image source](https://assets.science.nasa.gov/content/dam/science/esd/eo/content-feature/bluemarble/images/land_shallow_topo_2048.jpg) · [NASA media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).

NASA's guidance says its imagery generally is not subject to U.S. copyright and must not imply NASA endorsement. Check the linked guidelines before reusing the image, especially in commercial or promotional material.

## Validate

**Windows PowerShell**

```powershell
npm test
npm run build
.\.venv\Scripts\python.exe -m pytest -q
```

**macOS / Linux**

```sh
npm test
npm run build
.venv/bin/python -m pytest -q
```

Tests cover CMR granule parsing, supported backscatter conversion, mask filtering, and grid compatibility. No test fixture is represented as a live observation or scientific result.

The current 2D view is a custom equirectangular canvas map over the bundled Earth texture, not a tiled street map; coordinate selection and NASA CMR product footprints are geographic. Built-in place names are presets, not a global geocoder. Browse-preview side-by-side/swipe controls are for visual context only; only the backend's same-grid raster outputs support derived pixel-level comparison.

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and scientific contribution guidelines, and [SECURITY.md](./SECURITY.md) for credential and vulnerability-reporting guidance. GitHub Actions runs the frontend tests, backend tests, and production build without requiring an Earthdata token or live NASA API access.
