import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const catalogSource = await readFile(new URL("../src/catalog.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const mapSource = await readFile(new URL("../src/map.js", import.meta.url), "utf8");
const launcherSource = await readFile(new URL("../scripts/start.js", import.meta.url), "utf8");

test("catalog query changes invalidate selected observations and stop timeline playback", () => {
  assert.match(source, /function invalidateCatalog\(\)/);
  assert.match(source, /form\.addEventListener\("input", invalidateCatalog\)/);
  assert.match(source, /form\.addEventListener\("change", invalidateCatalog\)/);
  assert.match(source, /function invalidateCatalog\(\)[\s\S]*?stopTimelinePlayback\(\)/);
  assert.match(source, /function invalidateCatalog\(\)[\s\S]*?selectedIds\.clear\(\)/);
  assert.match(source, /function invalidateCatalog\(\)[\s\S]*?removeAttribute\("src"\)/);
});

test("CMR catalog link is disabled until a successful live search", () => {
  assert.match(source, /function invalidateCatalog\(\)[\s\S]*?\$\("#openCatalog"\)\.disabled = true/);
  assert.match(source, /\$\("#openCatalog"\)\.dataset\.url = response\.catalog_url/);
  assert.match(source, /\$\("#openCatalog"\)\.disabled = false/);
});

test("Earth recenter action preserves the selected study center", () => {
  assert.match(source, /let studyCenter = \{ latitude: 64\.4, longitude: -16\.8 \}/);
  assert.match(source, /globe\?\.focus\(studyCenter\.latitude, studyCenter\.longitude\)/);
});

test("study map receives a named geographic center", () => {
  assert.match(source, /createStudyMap\(\$\("#studyMap"\), \{\s*bounds: readBounds\(\),\s*center: studyCenter,/);
});

test("catalog failures expose a retry action and actionable guidance", () => {
  assert.match(html, /id="retryCatalog" type="button" hidden/);
  assert.match(source, /function catalogFailureMessage\(error\)/);
  assert.match(source, /FastAPI server is running on port 8000/);
  assert.match(source, /\$\("#retryCatalog"\)\.addEventListener\("click", searchCatalog\)/);
});

test("the change layer is built from derived raster cells and supports inspection", () => {
  assert.match(html, /id="toggleChangeLayer"[^>]+disabled/);
  assert.match(html, /id="changeCellReadout"/);
  assert.match(source, /studyMap\?\.setChangeCells\(changeCells\)/);
  assert.match(source, /onChangeCellSelected: inspectChangeCell/);
  assert.match(source, /changeCells\.length > 0/);
});

test("TERRA SIGHT navigation and reports expose distinct investigation stages", () => {
  assert.match(html, /<title>TERRA SIGHT — See beyond the surface<\/title>/);
  assert.match(html, /href="#earthSection" aria-current="page">Explore/);
  assert.match(html, /href="#discoverSection">Investigate/);
  assert.match(html, /href="#evidenceSection">Evidence/);
  assert.match(html, /href="#reportsSection">Reports/);
  assert.match(html, /id="exportHtmlReport"/);
  assert.match(source, /function saveInvestigationReport\(\)/);
  assert.match(source, /MAX_SAVED_REPORTS = 8/);
});

test("analytical comparison controls use processed rasters, not browse previews", () => {
  assert.match(html, /id="derivedComparisonPanel"[^>]+hidden/);
  assert.match(html, /id="beforeRasterPreview" alt="Before acquisition analytical gamma0 raster preview/);
  assert.match(source, /result\.comparison_previews/);
  assert.match(source, /function setRasterComparisonMode\(mode\)/);
  assert.match(mapSource, /onLocationSelected\(\s*Math\.max\(\s*-90/);
  assert.match(mapSource, /onChangeCellSelected\(selected\)/);
});

test("catalog query separates acquisition mode, subswath, and reported direction", () => {
  assert.match(html, /name="acquisition_mode"/);
  assert.match(html, /name="subswath"/);
  assert.match(html, /name="orbit_direction"/);
  assert.match(source, /"acquisition_mode", "subswath", "orbit_direction"/);
  assert.match(source, /function updateSubswathAvailability\(\)/);
  assert.match(catalogSource, /export function normalizeScene\(scene\)/);
  assert.match(catalogSource, /acquisition_mode: scene\.acquisition_mode \?\? modeMatch\?\.\[1\]/);
});

test("raster processing stays locked when backend health confirms no Earthdata token", () => {
  assert.match(source, /selectedPair\.length !== 2 \|\| earthdataTokenConfigured === false/);
  assert.match(source, /public source-preview comparison is ready/);
  assert.match(source, /Optional pixel analysis/);
  assert.match(source, /Direction filters only use direction when NASA CMR reports it/);
});

test("source browse previews can be compared visually without Earthdata credentials", () => {
  assert.match(html, /aria-label="Browse preview comparison layout"/);
  assert.match(html, /id="browseSwipeSlider"/);
  assert.match(html, /not a pixel-aligned or quantitative change measurement/);
  assert.match(source, /function setBrowseComparisonMode\(mode\)/);
  assert.match(source, /visual swipe or side-by-side review/);
  assert.match(source, /earthdataTokenConfigured !== true/);
});

test("temporal backscatter profiles require multiple compatible acquisitions and real rasters", () => {
  assert.match(html, /id="temporalProfileChart"/);
  assert.match(html, /3–6 compatible acquisitions/);
  assert.match(source, /function temporalProfileScenes\(\)/);
  assert.match(source, /MAX_TIME_SERIES_SCENES = 6/);
  assert.match(source, /\/api\/analysis\/backscatter-timeseries/);
  assert.match(html, /Every date is summarized over the same valid pixels/);
});

test("large catalog results use bounded, accessible client-side pages", () => {
  assert.match(html, /id="catalogPagination"/);
  assert.match(source, /const CATALOG_PAGE_SIZE = 50/);
  assert.match(source, /filtered\.slice\(start, start \+ CATALOG_PAGE_SIZE\)/);
});

test("selected comparison pair remains visible and removable across catalog pages", () => {
  assert.match(html, /id="selectedPairItems" aria-live="polite"/);
  assert.match(html, /id="clearSelection" type="button" disabled/);
  assert.match(source, /function renderSelectedPairSummary\(pair\)/);
  assert.match(source, /renderSelectedPairSummary\(pair\)/);
  assert.match(source, /Remove \$\{scene\.product_id\} from the comparison/);
});

test("the Earthdata token is inherited by the API but not the web server", () => {
  assert.match(launcherSource, /if \(!inheritEarthdataToken\) delete childEnvironment\.EARTHDATA_TOKEN/);
  assert.match(launcherSource, /inheritEarthdataToken: true/);
  assert.match(launcherSource, /An API is already running\. Stop the old API process/);
});

test("the session token input is masked and handled by the local API only", () => {
  assert.match(html, /id="earthdataToken" name="token" type="password"/);
  assert.match(html, /Never use this control on a public deployment/);
  assert.match(source, /requestJson\("\/api\/auth\/earthdata"/);
  assert.match(source, /input\.value = ""/);
  assert.match(source, /requestJson\("\/api\/auth\/earthdata", \{ method: "DELETE" \}\)/);
});

test("the Earthdata token setup is discoverable and the hero field note is removed", () => {
  assert.doesNotMatch(html, /FIELD NOTE \/ ICE & RADAR|id="studySummary"/);
  assert.match(html, /id="openEarthdataSetup"[^>]+aria-controls="credentialSetup"/);
  assert.match(html, /Connect your Earthdata Login token/);
  assert.match(html, /Pixel calculations run locally in the built-in scientific processor/);
  assert.match(source, /\$\("#openEarthdataSetup"\)\.addEventListener\("click"/);
});

test("local GeoTIFF comparison is discoverable without login and disclosed in reports", () => {
  assert.match(html, /Use local GeoTIFFs without Earthdata Login/);
  assert.match(html, /name="before_file" type="file"/);
  assert.match(html, /name="after_file" type="file"/);
  assert.match(html, /name="units" required/);
  assert.match(source, /\/api\/analysis\/local-backscatter/);
  assert.match(source, /new FormData\(formElement\)/);
  assert.match(source, /User-provided local GeoTIFF/);
  assert.match(source, /no OPERA quality mask was applied/);
  assert.match(source, /analysisResult\?\.source_assets/);
});

test("study defaults to a one-year catalog window and announces automatic matching", () => {
  assert.match(html, /LAST 12 MONTHS BY DEFAULT/);
  assert.match(source, /function setDefaultDateRange\(\)/);
  assert.match(source, /setDefaultDateRange\(\);\s*restoreStudyConfiguration\(\)/);
  assert.match(source, /auto-selected the latest compatible/);
});
