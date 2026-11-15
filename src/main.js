import { createStudyMap } from "./map.js";
import { compatiblePair, findDefaultPair, normalizeScene } from "./catalog.js";

const $ = (selector) => document.querySelector(selector);
const form = $("#catalogSearchForm");
const resultsRoot = $("#observationResults");
const selectedIds = new Set();
const STUDY_STORAGE_KEY = "terra-sight-study-v1";
const LEGACY_STUDY_STORAGE_KEY = "dwts-study-v1";
const SAVED_REPORTS_KEY = "terra-sight-reports-v1";
const MAX_SAVED_REPORTS = 8;
const CATALOG_PAGE_SIZE = 50;
const MAX_TIME_SERIES_SCENES = 6;
let scenes = [];
let selectedPair = [];
let displayPair = [];
let searchRecord = null;
let analysisResult = null;
let temporalProfileResult = null;
let earthdataTokenConfigured = null;
let catalogPage = 0;
let globe;
let studyMap;
let playTimer;
let studyCenter = { latitude: 64.4, longitude: -16.8 };
let studyName = "Vatnajökull, Iceland";

const PLACE_PRESETS = [
  { names: ["vatnajökull, iceland", "vatnajokull, iceland", "vatnajökull", "vatnajokull"], name: "Vatnajökull, Iceland", center: [64.4, -16.8], bounds: [-17, 64, -16, 65] },
  { names: ["san andreas fault, california", "san andreas fault"], name: "San Andreas Fault, California", center: [36, -120], bounds: [-120.5, 35.5, -119.5, 36.5] },
  { names: ["mount everest, nepal", "mount everest", "everest"], name: "Mount Everest, Nepal", center: [27.99, 86.93], bounds: [86.4, 27.5, 87.4, 28.5] },
  { names: ["reykjavik", "reykjavík"], name: "Reykjavík, Iceland", center: [64.15, -21.94], bounds: [-22.4, 63.65, -21.4, 64.65] },
  { names: ["mexico city", "mexico"], name: "Mexico City, Mexico", center: [19.43, -99.13], bounds: [-99.63, 18.93, -98.63, 19.93] },
];

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 3800);
}

function setStep(step, complete) {
  const element = $(`#method${step}`);
  if (!element) return;
  element.classList.toggle("complete", complete);
  element.classList.toggle("pending", !complete);
}

function setCatalogStatus(message, failed = false) {
  $("#catalogFeedback").textContent = message;
  $("#serviceStatus").textContent = failed
    ? "CATALOG REQUEST FAILED"
    : message.startsWith("Querying")
      ? "QUERYING NASA CMR"
      : message.includes("NASA CMR returned")
        ? "NASA CMR LIVE"
        : "STUDY AREA UPDATED";
  $("#serviceStatus").classList.toggle("service-error", failed);
  $("#serviceStatus").previousElementSibling.classList.toggle("pulse-dot-error", failed);
}

function catalogFailureMessage(error) {
  const details = error.message || "Unknown catalog error.";
  if (error.status === 422) {
    return `The catalog rejected this search (HTTP ${error.status}). Check the date range and geographic bounds. Details: ${details}`;
  }
  if (error.status && error.status < 500) {
    return `The catalog request was rejected (HTTP ${error.status}). Details: ${details}`;
  }
  if (error.status === 500) {
    return `The catalog service encountered an internal error (HTTP 500). This is not necessarily an internet problem. Check the terminal running the Python backend for the traceback, then retry. Details: ${details}`;
  }
  const localApiUnavailable = !error.status || (error.status === 502 && details.startsWith("Request failed"));
  const nextStep = localApiUnavailable
    ? "Check that the local FastAPI server is running on port 8000, then retry."
    : "NASA CMR or the catalog API may be temporarily unavailable. Retry shortly; transient upstream errors are retried once.";
  return `Live catalog data is temporarily unavailable. ${nextStep} Details: ${details}`;
}

function readBounds() {
  const data = new FormData(form);
  return {
    west: Number(data.get("west")),
    south: Number(data.get("south")),
    east: Number(data.get("east")),
    north: Number(data.get("north")),
  };
}

function formatCoordinates(latitude, longitude) {
  const lat = `${Math.abs(latitude).toFixed(2)}° ${latitude < 0 ? "S" : "N"}`;
  const lon = `${Math.abs(longitude).toFixed(2)}° ${longitude < 0 ? "W" : "E"}`;
  return `${lat} · ${lon}`;
}

function updateStudyCoordinates(latitude, longitude, focusGlobe = false) {
  studyCenter = { latitude, longitude };
  const coordinates = formatCoordinates(latitude, longitude);
  $("#globeStudyCoordinates").textContent = coordinates;
  $("#globeReadoutCoordinates").textContent = coordinates;
  if (focusGlobe) globe?.focus(latitude, longitude);
  else globe?.setStudyPoint(latitude, longitude);
  studyMap?.setCenter(latitude, longitude);
  studyMap?.setBounds(readBounds());
  $("#mapCoordinates").textContent = `${coordinates} · WGS84`;
}

function updateAnalysisReadiness() {
  const analysisButton = $("#runAnalysisButton");
  analysisButton.disabled =
    selectedPair.length !== 2 || earthdataTokenConfigured === false;
  analysisButton.textContent = earthdataTokenConfigured === false
    ? "Optional pixel analysis · token required"
    : "Run real backscatter analysis";
  if (selectedPair.length !== 2) return;
  const [before, after] = selectedPair;
  const pairDescription =
    `${before.tile} · ${before.acquisition_mode ?? "mode not reported"} subswath ${before.subswath ?? "not reported"}`;
  const platformNote = before.platform !== after.platform
    ? " · cross-platform; interpret cautiously"
    : "";
  if (earthdataTokenConfigured === true) {
    $("#analysisReadiness").textContent =
      `${pairDescription}${platformNote} · grids and masks will be verified after download.`;
  } else if (earthdataTokenConfigured === false) {
    $("#analysisReadiness").textContent =
      `${pairDescription}${platformNote} · public source-preview comparison is ready; pixel analysis needs Earthdata access.`;
  } else {
    $("#analysisReadiness").textContent =
      `${pairDescription}${platformNote} · backend processing access has not been verified.`;
  }
}

async function configureEarthdataToken(event) {
  event.preventDefault();
  const input = $("#earthdataToken");
  const button = $("#earthdataCredentialForm button[type='submit']");
  const status = $("#earthdataCredentialStatus");
  const token = input.value.trim();
  if (!token) {
    status.dataset.state = "error";
    status.textContent = "Paste a non-empty Earthdata Login token.";
    return;
  }

  button.disabled = true;
  button.textContent = "CONNECTING…";
  status.dataset.state = "";
  status.textContent = "Sending token to the local backend…";
  try {
    const result = await requestJson("/api/auth/earthdata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    earthdataTokenConfigured = result.earthdata_token_configured === true;
    updateAnalysisAccess();
    status.dataset.state = "ready";
    status.textContent =
      "Token is held in local backend memory. Source access will be checked when analysis runs.";
    $("#credentialSetup").open = false;
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = `Could not configure token: ${error.message}`;
  } finally {
    input.value = "";
    button.disabled = false;
    button.textContent = "Connect token";
  }
}

async function forgetEarthdataToken() {
  const button = $("#forgetEarthdataToken");
  button.disabled = true;
  try {
    const result = await requestJson("/api/auth/earthdata", { method: "DELETE" });
    earthdataTokenConfigured = result.earthdata_token_configured === true;
    updateAnalysisAccess();
    $("#credentialSetup").open = true;
    $("#earthdataCredentialStatus").textContent =
      "Session token forgotten by the local backend.";
  } catch (error) {
    $("#earthdataCredentialStatus").dataset.state = "error";
    $("#earthdataCredentialStatus").textContent =
      `Could not clear the session token: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function updateAnalysisAccess(errorMessage = "") {
  if (earthdataTokenConfigured === true) {
    $("#qualityAccess").textContent =
      "The local scientific processor is ready. NASA access, checksums, grids, units, and quality masks are validated when real source rasters are requested.";
    $("#workflowStatus").textContent = "PRODUCT NOT REQUESTED";
  } else if (earthdataTokenConfigured === false) {
    $("#qualityAccess").textContent =
      "Local pixel processing is built in. Add your Earthdata Login token to retrieve source rasters; public catalog discovery and browse previews work without it.";
    $("#workflowStatus").textContent = "PUBLIC PREVIEWS READY";
  } else {
    $("#qualityAccess").textContent = errorMessage
      ? `Backend access check failed: ${errorMessage}. Token entry is available only through the local app.`
      : "Earthdata access could not be verified. Connect to the local backend before entering a token.";
    $("#workflowStatus").textContent = errorMessage
      ? "ACCESS CHECK FAILED"
      : "ACCESS CHECK PENDING";
  }
  updateCredentialControls();
  updateAnalysisReadiness();
  updateTemporalProfileAvailability();
}

function updateCredentialControls() {
  const status = $("#earthdataCredentialStatus");
  const forgetButton = $("#forgetEarthdataToken");
  const setupButton = $("#openEarthdataSetup");
  forgetButton.hidden = earthdataTokenConfigured !== true;
  setupButton.textContent =
    earthdataTokenConfigured === true
      ? "Manage Earthdata token"
      : "Add Earthdata token for local analysis";
  status.dataset.state = earthdataTokenConfigured === true ? "ready" : "";
  status.textContent = earthdataTokenConfigured === true
    ? "Token held in local backend memory. NASA validates data access when you run an analysis."
    : earthdataTokenConfigured === false
      ? "No token is set for this backend session."
      : "Backend token status is not available.";
}

function inspectChangeCell(cell) {
  if (!cell) {
    $("#changeCellReadout").textContent =
      "No derived cell at that location. It may fall outside the processed swath or contain no quality-screened pixels.";
    return;
  }
  const [west, south, east, north] = cell.bounds_wgs84;
  const center = formatCoordinates((south + north) / 2, (west + east) / 2);
  const fraction = (cell.valid_pixel_fraction * 100).toFixed(1);
  const delta = Number(cell.median_delta_db);
  $("#changeCellReadout").textContent =
    `DERIVED CELL · ${center} · median Δγ⁰ ${delta > 0 ? "+" : ""}${delta.toFixed(2)} dB · ` +
    `${cell.valid_pixels.toLocaleString()}/${cell.total_pixels.toLocaleString()} valid pixels (${fraction}%). ` +
    "Backscatter change is not displacement.";
}

async function checkAnalysisAccess() {
  try {
    const health = await requestJson("/api/health");
    earthdataTokenConfigured = health.earthdata_token_configured === true;
    updateAnalysisAccess();
  } catch (error) {
    earthdataTokenConfigured = null;
    updateAnalysisAccess(error.message);
  }
}

function stopTimelinePlayback() {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  $("#playTimeline").textContent = "▶";
  $("#playTimeline").setAttribute("aria-label", "Play between observation dates");
}

function clearAnalysisResult() {
  analysisResult = null;
  temporalProfileResult = null;
  $("#derivedComparisonPanel").hidden = true;
  $("#analysisMapPanel").hidden = true;
  $("#temporalProfileResult").hidden = true;
  $("#temporalObservationRows").replaceChildren();
  $("#temporalProfileStatus").removeAttribute("role");
  $("#temporalProfileStatus").textContent =
    "Search a wider date range to discover repeated acquisitions.";
  $("#browseSwipePanel").hidden = true;
  $("#browseSwipeSlider").disabled = true;
  $("#browseSideBySideButton").disabled = true;
  $("#browseSwipeButton").disabled = true;
  $("#browseComparisonArea").dataset.view = "side-by-side";
  $("#browseSideBySideButton").setAttribute("aria-pressed", "true");
  $("#browseSwipeButton").setAttribute("aria-pressed", "false");
  $("#beforeRasterPreview").removeAttribute("src");
  $("#afterRasterPreview").removeAttribute("src");
  $("#beforeRasterSide").removeAttribute("src");
  $("#afterRasterSide").removeAttribute("src");
  $("#changeLayerLegend").hidden = true;
  $("#changeCellReadout").textContent =
    "Derived cell inspection appears only after a real raster comparison; click a colored cell to inspect its evidence.";
  const layerButton = $("#toggleChangeLayer");
  layerButton.disabled = true;
  layerButton.setAttribute("aria-pressed", "false");
  layerButton.setAttribute("aria-label", "Show derived radar change layer");
  studyMap?.setChangeCells([]);
  studyMap?.setChangeLayerVisible(false);
  $("#analysisSummary").textContent = "No raster comparison has been run. Source previews are not analysis inputs.";
  $("#evidenceClassification").textContent = searchRecord
    ? searchRecord.count
      ? "MEASURED CATALOG METADATA"
      : "VERIFIED EMPTY CMR QUERY"
    : "NO LIVE EVIDENCE";
  $("#workflowStatus").textContent = earthdataTokenConfigured === false
    ? "PIXEL ANALYSIS NEEDS TOKEN"
    : earthdataTokenConfigured === true
      ? "PRODUCT NOT REQUESTED"
      : "ACCESS CHECK PENDING";
  setStep("Analysis", false);
  setStep("Report", false);
}

function invalidateCatalog() {
  stopTimelinePlayback();
  $("#retryCatalog").hidden = true;
  scenes = [];
  selectedIds.clear();
  selectedPair = [];
  displayPair = [];
  searchRecord = null;
  catalogPage = 0;
  clearAnalysisResult();
  resultsRoot.replaceChildren();
  $("#sceneCount").textContent = "00";
  $("#timelineStatus").textContent = "NO RESULTS LOADED";
  $("#timelinePeriod").textContent = "WAITING FOR LIVE OBSERVATIONS";
  $("#timelineSlider").disabled = true;
  $("#playTimeline").disabled = true;
  $("#browseImage").removeAttribute("src");
  $("#secondBrowseImage").removeAttribute("src");
  $("#browseSwipeBefore").removeAttribute("src");
  $("#browseSwipeAfter").removeAttribute("src");
  $("#browseDateLabel").textContent = "NO PRODUCT SELECTED";
  $("#secondBrowseDateLabel").textContent = "NO PRODUCT SELECTED";
  $("#browseProduct").textContent = "Waiting for live CMR results…";
  $("#secondBrowseProduct").textContent = "Waiting for live CMR results…";
  $("#downloadBrowse").dataset.url = "";
  $("#downloadBrowse2").dataset.url = "";
  $("#catalogStatusBadge").textContent = "QUERY PENDING";
  $("#catalogStatusBadge").classList.remove("catalog-live");
  $("#openCatalog").disabled = true;
  globe?.setFootprint(null);
  studyMap?.setBounds(readBounds());
  studyMap?.setFootprint(null);
  renderCatalog();
}

function applyStudyArea(name, latitude, longitude, bounds) {
  const current = readBounds();
  const halfWidth = bounds
    ? (bounds[2] - bounds[0]) / 2
    : Math.max(0.1, Math.min(1, (current.east - current.west) / 2));
  const halfHeight = bounds
    ? (bounds[3] - bounds[1]) / 2
    : Math.max(0.1, Math.min(1, (current.north - current.south) / 2));
  form.elements.west.value = (bounds ? bounds[0] : Math.max(-180, longitude - halfWidth)).toFixed(2);
  form.elements.east.value = (bounds ? bounds[2] : Math.min(180, longitude + halfWidth)).toFixed(2);
  form.elements.south.value = (bounds ? bounds[1] : Math.max(-90, latitude - halfHeight)).toFixed(2);
  form.elements.north.value = (bounds ? bounds[3] : Math.min(90, latitude + halfHeight)).toFixed(2);
  studyName = name;
  $("#placeSearch").value = name;
  $("#globeStudyName").textContent = name;
  $("#globeReadoutName").textContent = name.split(",")[0];
  updateStudyCoordinates(latitude, longitude, true);
  invalidateCatalog();
  setCatalogStatus("Study area updated. Search NASA CMR to retrieve real observations.");
}

function chooseStudyLocation(value) {
  const query = value.trim().toLowerCase();
  if (!query) {
    showToast("Enter a known place name or coordinates such as 64.4, -16.8.");
    return;
  }
  const preset = PLACE_PRESETS.find((place) => place.names.includes(query));
  if (preset) {
    applyStudyArea(preset.name, preset.center[0], preset.center[1], preset.bounds);
    return;
  }
  const coordinates = query.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (coordinates) {
    const latitude = Number(coordinates[1]);
    const longitude = Number(coordinates[2]);
    if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      applyStudyArea("Coordinate search", latitude, longitude);
      return;
    }
  }
  showToast("That place is not in the local preset list. Try a suggested place or enter latitude, longitude.");
}

function handleLocationSelection(latitude, longitude) {
  const data = new FormData(form);
  const halfWidth = Math.max(0.1, Math.min(1, (Number(data.get("east")) - Number(data.get("west"))) / 2));
  const halfHeight = Math.max(0.1, Math.min(1, (Number(data.get("north")) - Number(data.get("south"))) / 2));
  const west = Math.max(-180, longitude - halfWidth);
  const east = Math.min(180, longitude + halfWidth);
  const south = Math.max(-90, latitude - halfHeight);
  const north = Math.min(90, latitude + halfHeight);
  form.elements.west.value = west.toFixed(2);
  form.elements.east.value = east.toFixed(2);
  form.elements.south.value = south.toFixed(2);
  form.elements.north.value = north.toFixed(2);
  $("#globeStudyName").textContent = "Selected map area";
  $("#globeReadoutName").textContent = "Selected area";
  updateStudyCoordinates(latitude, longitude);
  invalidateCatalog();
  setCatalogStatus("Map area updated. Search NASA CMR to retrieve real observations.");
}

function buildSearchParams() {
  const data = new FormData(form);
  const params = new URLSearchParams();
  for (const name of ["west", "south", "east", "north", "start_date", "end_date", "platform", "polarization", "relative_track", "acquisition_mode", "subswath", "orbit_direction"]) {
    const value = String(data.get(name) ?? "").trim();
    if (value) params.set(name, value);
  }
  return params;
}

function updateSubswathAvailability() {
  const selectedMode = form.elements.acquisition_mode.value;
  const supportsSubswath = !selectedMode || ["IW", "EW"].includes(selectedMode);
  if (!supportsSubswath) form.elements.subswath.value = "";
  form.elements.subswath.disabled = !supportsSubswath;
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(`Could not reach the application API: ${error.message}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body.detail === "string" ? body.detail : `Request failed (${response.status}).`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return body;
}

function filteredScenes() {
  const query = $("#sceneFilter").value.trim().toLowerCase();
  if (!query) return scenes;
  return scenes.filter((scene) =>
    [scene.product_id, scene.platform, scene.tile, scene.id]
      .some((value) => String(value).toLowerCase().includes(query)),
  );
}

function createSceneRow(scene) {
  const row = document.createElement("article");
  row.className = "catalog-scene";
  row.dataset.sceneId = scene.id;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = selectedIds.has(scene.id);
  checkbox.setAttribute("aria-label", `Select ${scene.platform} acquisition ${scene.acquired_at}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked && selectedIds.size >= 2) {
      checkbox.checked = false;
      showToast("Select at most two scenes for a comparison.");
      return;
    }
    if (checkbox.checked) selectedIds.add(scene.id);
    else selectedIds.delete(scene.id);
    clearAnalysisResult();
    renderCatalog();
  });

  const details = document.createElement("div");
  details.className = "catalog-scene-details";
  const heading = document.createElement("div");
  heading.className = "catalog-scene-heading";
  const title = document.createElement("strong");
  title.textContent = `${scene.platform} · ${new Date(scene.acquired_at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const chip = document.createElement("span");
  chip.textContent = scene.tile;
  heading.append(title, chip);
  const metadata = document.createElement("span");
  metadata.textContent =
    `${scene.acquisition_mode ?? "mode not reported"} · subswath ${scene.subswath ?? "not reported"} · ${scene.polarizations.join("/")} · ` +
    `relative track ${scene.relative_track ?? "not reported"} · orbit ${scene.orbit_number ?? "not reported"}`;
  const product = document.createElement("code");
  product.textContent = scene.product_id;
  details.append(heading, metadata, product);

  const source = document.createElement("button");
  source.type = "button";
  source.className = "scene-source";
  source.textContent = "CMR ↗";
  source.addEventListener("click", () => openSource(scene.source_url));

  row.append(checkbox, details, source);
  return row;
}

function selectedScenes() {
  return scenes.filter((scene) => selectedIds.has(scene.id))
    .sort((a, b) => a.acquired_at.localeCompare(b.acquired_at));
}

function renderSelectedPairSummary(pair) {
  $("#selectedPairCount").textContent = `${pair.length} / 2 selected`;
  $("#clearSelection").disabled = pair.length === 0;
  if (!pair.length) {
    const empty = document.createElement("p");
    empty.textContent =
      "Select two observations. Your selection stays visible while you browse catalog pages.";
    $("#selectedPairItems").replaceChildren(empty);
    return;
  }

  const rows = pair.map((scene, index) => {
    const row = document.createElement("div");
    row.className = "selected-observation";

    const label = document.createElement("span");
    label.className = "selected-observation-label";
    label.textContent = pair.length === 2 ? (index === 0 ? "BEFORE" : "AFTER") : "SELECTED";

    const details = document.createElement("div");
    details.className = "selected-observation-details";
    const heading = document.createElement("strong");
    heading.textContent =
      `${formatDate(scene.acquired_at)} · ${scene.platform} · ${scene.tile}`;
    const product = document.createElement("code");
    product.textContent = scene.product_id;
    details.append(heading, product);

    const actions = document.createElement("div");
    actions.className = "selected-observation-actions";
    const source = document.createElement("button");
    source.type = "button";
    source.textContent = "SOURCE";
    source.setAttribute("aria-label", `Open NASA CMR record for ${scene.product_id}`);
    source.addEventListener("click", () => openSource(scene.source_url));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "REMOVE";
    remove.setAttribute("aria-label", `Remove ${scene.product_id} from the comparison`);
    remove.addEventListener("click", () => {
      selectedIds.delete(scene.id);
      clearAnalysisResult();
      renderCatalog();
    });
    actions.append(source, remove);
    row.append(label, details, actions);
    return row;
  });
  $("#selectedPairItems").replaceChildren(...rows);
}

function renderCatalog() {
  const filtered = filteredScenes();
  const pageCount = Math.max(1, Math.ceil(filtered.length / CATALOG_PAGE_SIZE));
  catalogPage = Math.min(catalogPage, pageCount - 1);
  const start = catalogPage * CATALOG_PAGE_SIZE;
  resultsRoot.replaceChildren(
    ...filtered.slice(start, start + CATALOG_PAGE_SIZE).map(createSceneRow),
  );
  $("#catalogPagination").hidden = filtered.length <= CATALOG_PAGE_SIZE;
  $("#catalogPreviousPage").disabled = catalogPage === 0;
  $("#catalogNextPage").disabled = catalogPage >= pageCount - 1;
  $("#catalogPageStatus").textContent =
    `PAGE ${catalogPage + 1} / ${pageCount} · ${filtered.length.toLocaleString()} MATCHES`;
  $("#sceneCount").textContent = String(scenes.length).padStart(2, "0");

  const pair = selectedScenes();
  renderSelectedPairSummary(pair);
  const ready = pair.length === 2 && compatiblePair(pair[0], pair[1]);
  selectedPair = ready ? pair : [];
  displayPair = pair.length === 2 ? pair : [];
  $("#analysisReadiness").textContent = ready
    ? `${pair[0].tile} · ${pair[0].acquisition_mode} subswath ${pair[0].subswath} · ${pair[0].polarizations.filter((pol) => pair[1].polarizations.includes(pol)).join("/")} pair; grid check pending`
    : pair.length === 2
      ? "Selected products are not a same-tile, same-mode pair."
      : "Select two same-tile observations.";

  if (displayPair.length === 2) {
    $("#timelineSlider").disabled = false;
    $("#playTimeline").disabled = false;
    updateTemporalPair(displayPair);
  }
  else {
    $("#timelineSlider").disabled = true;
    $("#playTimeline").disabled = true;
  }
  updateQualitySummary(pair, ready);
  updateAnalysisReadiness();
  updateTemporalProfileAvailability();
  if (!ready && pair.length === 1) $("#workflowStatus").textContent = "PRODUCT AVAILABLE · SELECT A SECOND";
  else if (!ready && scenes.length) $("#workflowStatus").textContent = "CATALOG VERIFIED · SELECT A PAIR";
}

function updateQualitySummary(pair, ready) {
  const status = $("#qualityPairStatus");
  if (pair.length < 2) {
    status.textContent = pair.length ? "SELECT A SECOND OBSERVATION" : "AWAITING PAIR";
    status.classList.remove("quality-ready", "quality-warning");
    $("#qualityPairing").textContent = pair.length
      ? "One observation is selected. Choose another acquisition that shares its burst tile, mode, subswath, and a polarization."
      : "Compatibility is checked from tile, acquisition mode, subswath, and shared polarization. Direction filters only use direction when NASA CMR reports it.";
    return;
  }
  status.textContent = ready ? "PAIR METADATA MATCH · GRID CHECK PENDING" : "PAIR NOT COMPATIBLE";
  status.classList.toggle("quality-ready", ready);
  status.classList.toggle("quality-warning", !ready);
  $("#qualityPairing").textContent = ready
    ? `Both ${pair[0].tile} ${pair[0].acquisition_mode} subswath ${pair[0].subswath} products share ${pair[0].polarizations.filter((pol) => pair[1].polarizations.includes(pol)).join("/")} polarization. Raster grid, mask, and processing version checks still run on the backend.${pair[0].platform !== pair[1].platform ? " The Sentinel platforms differ, so instrument differences remain a limitation." : ""}`
    : "Selected scenes do not share the burst tile, acquisition mode, subswath, processing version, orbit direction (when reported), and polarization required for this comparison.";
  if (ready) {
    $("#workflowStatus").textContent = earthdataTokenConfigured === false
      ? "PIXEL ANALYSIS NEEDS TOKEN"
      : "PRODUCT AVAILABLE · RASTER PENDING";
  }
}

function temporalProfileScenes() {
  const anchor = selectedPair[0]
    ?? selectedScenes()[0]
    ?? findDefaultPair(scenes)[0]
    ?? scenes[0];
  if (!anchor) return [];
  const polarization = form.elements.polarization.value
    || anchor.polarizations[0];
  if (!polarization) return [];

  const byUtcDate = new Map();
  for (const scene of scenes) {
    const compatible = scene.id === anchor.id || compatiblePair(anchor, scene);
    if (!compatible || !scene.polarizations.includes(polarization)) continue;
    const date = scene.acquired_at.slice(0, 10);
    const existing = byUtcDate.get(date);
    if (!existing || scene.platform === anchor.platform) byUtcDate.set(date, scene);
  }
  const observations = [...byUtcDate.values()]
    .sort((a, b) => a.acquired_at.localeCompare(b.acquired_at));
  if (observations.length <= MAX_TIME_SERIES_SCENES) return observations;
  return Array.from({ length: MAX_TIME_SERIES_SCENES }, (_, index) => {
    const sourceIndex = Math.round(
      index * (observations.length - 1) / (MAX_TIME_SERIES_SCENES - 1),
    );
    return observations[sourceIndex];
  });
}

function updateTemporalProfileAvailability() {
  const candidates = temporalProfileScenes();
  const button = $("#runTemporalProfile");
  button.disabled = candidates.length < 3 || earthdataTokenConfigured !== true;
  button.textContent = "Build temporal profile";
  if (!scenes.length) {
    $("#temporalProfileStatus").textContent =
      "Search a wider date range to discover repeated acquisitions.";
  } else if (candidates.length < 3) {
    $("#temporalProfileStatus").textContent =
      `${candidates.length} compatible UTC date${candidates.length === 1 ? "" : "s"} found for the selected burst and polarization. Expand the date range or choose another area to find at least three.`;
  } else if (earthdataTokenConfigured === false) {
    $("#temporalProfileStatus").textContent =
      `${candidates.length} compatible acquisitions found. A derived VV/VH profile requires EARTHDATA_TOKEN on the backend; visual CMR browse comparison remains available without it.`;
  } else if (earthdataTokenConfigured !== true) {
    $("#temporalProfileStatus").textContent =
      `${candidates.length} compatible acquisitions found. Waiting for the backend Earthdata access check.`;
  } else {
    const platforms = new Set(candidates.map((scene) => scene.platform));
    $("#temporalProfileStatus").textContent =
      `${candidates.length} real acquisitions are ready for a common-pixel temporal profile.${platforms.size > 1 ? " Multiple Sentinel platforms are present; interpret instrument differences cautiously." : ""}`;
  }
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function renderTemporalProfile(result) {
  temporalProfileResult = result;
  const observations = result.observations;
  const svg = $("#temporalProfileChart");
  const title = svg.querySelector("#temporalChartTitle");
  const description = svg.querySelector("#temporalChartDescription");
  svg.replaceChildren(title, description);
  const width = 900;
  const height = 340;
  const margin = { top: 24, right: 28, bottom: 76, left: 88 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = observations.map((item) => item.median_backscatter_db);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.15, 0.5);
  const low = min - padding;
  const high = max + padding;
  const firstTime = Date.parse(observations[0].acquired_at);
  const lastTime = Date.parse(observations[observations.length - 1].acquired_at);
  const x = (date) => margin.left + (
    (Date.parse(date) - firstTime) / Math.max(lastTime - firstTime, 1)
  ) * plotWidth;
  const y = (value) => margin.top + (high - value) / (high - low) * plotHeight;

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = high - (high - low) * tick / 4;
    const position = y(value);
    svg.append(
      svgElement("line", {
        x1: margin.left,
        x2: width - margin.right,
        y1: position,
        y2: position,
        class: "chart-grid",
      }),
      Object.assign(svgElement("text", {
        x: margin.left - 10,
        y: position + 4,
        "text-anchor": "end",
        class: "chart-label",
      }), { textContent: `${value.toFixed(1)}` }),
    );
  }
  svg.append(
    svgElement("line", {
      x1: margin.left,
      x2: margin.left,
      y1: margin.top,
      y2: height - margin.bottom,
      class: "chart-axis",
    }),
    svgElement("line", {
      x1: margin.left,
      x2: width - margin.right,
      y1: height - margin.bottom,
      y2: height - margin.bottom,
      class: "chart-axis",
    }),
  );
  const points = observations.map((item) => ({
    x: x(item.acquired_at),
    y: y(item.median_backscatter_db),
  }));
  svg.append(svgElement("path", {
    d: points.map((point, index) =>
      `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`,
    ).join(" "),
    class: "chart-line",
  }));
  observations.forEach((item, index) => {
    const point = points[index];
    const circle = svgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: 6,
      class: "chart-point",
    });
    const tooltip = svgElement("title");
    tooltip.textContent =
      `${formatDate(item.acquired_at)} · ${item.median_backscatter_db.toFixed(2)} dB · ${item.platform}`;
    circle.append(tooltip);
    svg.append(circle);
    if (
      index === 0
      || index === observations.length - 1
      || observations.length <= 4
    ) {
      const dateLabel = svgElement("text", {
        x: point.x,
        y: height - margin.bottom + 24,
        "text-anchor": index === 0
          ? "start"
          : index === observations.length - 1
            ? "end"
            : "middle",
        class: "chart-label",
      });
      dateLabel.textContent = formatDate(item.acquired_at);
      svg.append(dateLabel);
    }
  });
  const axisLabel = svgElement("text", {
    x: 22,
    y: height / 2,
    transform: `rotate(-90 22 ${height / 2})`,
    "text-anchor": "middle",
    class: "chart-axis-label",
  });
  axisLabel.textContent = `Median ${result.polarization} γ⁰ backscatter (dB)`;
  svg.append(axisLabel);
  title.textContent = `${result.polarization} gamma-zero backscatter over time`;
  description.textContent =
    `${observations.length} acquisitions summarized over ${result.coverage.common_valid_pixels.toLocaleString()} pixels valid in every selected date. This is radar backscatter intensity, not displacement.`;
  const difference = observations[observations.length - 1].median_backscatter_db
    - observations[0].median_backscatter_db;
  const coverage = 100 * result.coverage.common_valid_pixel_fraction;
  $("#temporalProfileSummary").textContent =
    `${observations.length} DERIVED ACQUISITIONS · ${result.polarization} · ` +
    `${result.coverage.common_valid_pixels.toLocaleString()} common pixels (${coverage.toFixed(1)}% of the requested grid) · ` +
    `first-to-last median change ${difference > 0 ? "+" : ""}${difference.toFixed(2)} dB. ` +
    "This is backscatter intensity change, not surface movement.";

  const rows = observations.map((item) => {
    const row = document.createElement("tr");
    const cells = [
      formatDate(item.acquired_at),
      item.platform,
      `${item.median_backscatter_db.toFixed(2)} dB`,
      item.common_valid_pixels.toLocaleString(),
    ];
    for (const text of cells) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    const sourceCell = document.createElement("td");
    const sourceUrl = safeSourceUrl(item.source_url);
    if (sourceUrl) {
      const link = document.createElement("a");
      link.href = sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = item.cmr_id;
      sourceCell.append(link);
    } else {
      sourceCell.textContent = item.cmr_id;
    }
    row.append(sourceCell);
    return row;
  });
  $("#temporalObservationRows").replaceChildren(...rows);
  $("#temporalProfileResult").hidden = false;
  $("#temporalProfileStatus").removeAttribute("role");
  $("#temporalProfileStatus").textContent =
    `DERIVED PROFILE READY · ${observations.length} ACQUISITIONS · COMMON VALID PIXELS ${coverage.toFixed(1)}%`;
  if (result.quality.cross_platform_warning) {
    $("#temporalProfileStatus").textContent +=
      ` · CAVEAT: ${result.quality.cross_platform_warning}`;
  }
}

async function runTemporalProfile() {
  const candidates = temporalProfileScenes();
  if (candidates.length < 3 || earthdataTokenConfigured !== true) return;
  const polarization = form.elements.polarization.value
    || candidates[0].polarizations[0];
  const bounds = readBounds();
  const button = $("#runTemporalProfile");
  button.disabled = true;
  button.textContent = "RETRIEVING REAL RTC OBSERVATIONS…";
  $("#temporalProfileStatus").removeAttribute("role");
  $("#temporalProfileStatus").textContent =
    `Downloading and validating ${candidates.length} ${polarization} acquisitions and quality masks.`;
  try {
    const result = await requestJson("/api/analysis/backscatter-timeseries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scene_ids: candidates.map((scene) => scene.id),
        polarization,
        bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
      }),
    });
    renderTemporalProfile(result);
  } catch (error) {
    $("#temporalProfileStatus").setAttribute("role", "alert");
    $("#temporalProfileStatus").textContent =
      `Temporal profile unavailable: ${error.message}`;
    $("#temporalProfileResult").hidden = true;
  } finally {
    button.disabled = candidates.length < 3 || earthdataTokenConfigured !== true;
    button.textContent = "Build temporal profile";
  }
}

function renderScenePair(items) {
  const pair = findDefaultPair(items);
  selectedIds.clear();
  if (pair.length === 2) pair.forEach((scene) => selectedIds.add(scene.id));

  if (items.length) {
    setStep("Catalog", true);
    $("#catalogStatusBadge").textContent = "LIVE CMR";
    $("#catalogStatusBadge").classList.add("catalog-live");
    const latest = pair[1] ?? items.reduce((newest, scene) =>
      Date.parse(scene.acquired_at) > Date.parse(newest.acquired_at) ? scene : newest,
    );
    $("#globeStudyName").textContent = "CMR footprint / selected burst";
    $("#globeReadoutName").textContent = "Search area";
    const bounds = readBounds();
    const centerLat = (bounds.south + bounds.north) / 2;
    const centerLon = (bounds.west + bounds.east) / 2;
    updateStudyCoordinates(centerLat, centerLon, true);
    globe?.setFootprint(latest.geometry);
    studyMap?.setFootprint(latest.geometry);
  } else {
    setStep("Catalog", false);
    $("#catalogStatusBadge").textContent = "NO MATCHING SCENES";
    $("#sceneCount").textContent = "00";
    globe?.setFootprint(null);
    studyMap?.setFootprint(null);
  }

  renderCatalog();
  if (searchRecord?.catalog_complete === false) {
    setCatalogStatus(
      `NASA CMR returned a partial page of ${items.length.toLocaleString()} scenes; narrow the date range or area for complete coverage.`,
      true,
    );
    $("#catalogStatusBadge").textContent = "CMR RESULTS CAPPED";
    $("#catalogStatusBadge").classList.remove("catalog-live");
    return;
  }
  if (pair.length === 2) {
    const pairType = pair[0].platform === pair[1].platform
      ? `${pair[0].platform} same-platform`
      : `cross-platform ${pair[0].platform}/${pair[1].platform} fallback`;
    setCatalogStatus(
      `NASA CMR returned ${items.length.toLocaleString()} scenes; auto-selected the latest compatible ${pairType} pair on ${pair[0].tile}.`,
    );
  } else if (items.length) {
    setCatalogStatus(`NASA CMR returned ${items.length} scene${items.length === 1 ? "" : "s"}, but no compatible same-tile pair was found.`);
  }
}

function setDefaultDateRange() {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 365);
  form.elements.start_date.value = start.toISOString().slice(0, 10);
  form.elements.end_date.value = end.toISOString().slice(0, 10);
}

async function searchCatalog() {
  const query = buildSearchParams().toString();
  $("#retryCatalog").hidden = true;
  $("#catalogSearchButton").disabled = true;
  $("#catalogSearchButton").textContent = "QUERYING NASA CMR…";
  setCatalogStatus("Querying NASA CMR for current OPERA RTC-S1 granules…");
  resultsRoot.replaceChildren();
  try {
    const response = await requestJson(`/api/catalog/search?${query}`);
    if (query !== buildSearchParams().toString()) return;
    $("#retryCatalog").hidden = true;
    scenes = response.scenes.map(normalizeScene);
    searchRecord = response;
    clearAnalysisResult();
    $("#openCatalog").dataset.url = response.catalog_url;
    $("#openCatalog").disabled = false;
    $("#timelineStatus").textContent =
      `${response.count.toLocaleString()} CMR SCENES${response.catalog_complete === false ? " · PARTIAL" : ""}`;
    $("#evidenceCopy").textContent = response.count
      ? `${response.count.toLocaleString()} OPERA RTC-S1 scenes are returned by the live NASA CMR catalog for this query.`
      : "NASA CMR returned no catalog records for this area and date range.";
    if (response.catalog_complete === false) {
      $("#evidenceCopy").textContent +=
        ` The display is capped at ${response.scenes.length.toLocaleString()} of ${Number(response.cmr_total_hits).toLocaleString()} CMR hits; narrow the date range or area to retrieve a complete result.`;
    }
    $("#evidenceClassification").textContent = response.count
      ? "MEASURED CATALOG METADATA"
      : "NO MATCHING OBSERVATIONS";
    $("#workflowStatus").textContent = response.count
      ? "CATALOG VERIFIED"
      : "NO PRODUCT AVAILABLE";
    $("#analysisSummary").textContent = "Catalog metadata is live. A derived product has not been calculated.";
    $("#analysisMapPanel").hidden = true;
    setStep("Products", false);
    setStep("Analysis", false);
    setStep("Report", false);
    renderScenePair(scenes);
  } catch (error) {
    if (query !== buildSearchParams().toString()) return;
    scenes = [];
    selectedIds.clear();
    selectedPair = [];
    searchRecord = null;
    clearAnalysisResult();
    $("#openCatalog").disabled = true;
    globe?.setFootprint(null);
    studyMap?.setFootprint(null);
    renderCatalog();
    const message = catalogFailureMessage(error);
    $("#retryCatalog").hidden = Boolean(error.status && error.status < 500);
    setCatalogStatus(message, true);
    $("#catalogStatusBadge").textContent = "CATALOG ERROR";
    $("#timelineStatus").textContent = "REQUEST FAILED";
    $("#evidenceClassification").textContent = "CATALOG REQUEST FAILED";
    $("#workflowStatus").textContent = "CATALOG FAILED";
    $("#evidenceCopy").textContent = "NASA CMR did not return data for this query. No observations or comparison result are assumed.";
  } finally {
    $("#catalogSearchButton").disabled = false;
    $("#catalogSearchButton").innerHTML = 'SEARCH NASA CMR <span>↗</span>';
  }
}

function formatDate(value) {
  if (!value) return "NO PRODUCT SELECTED";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value)).toUpperCase();
}

function safeSourceUrl(url) {
  try {
    const parsed = new URL(url);
    const trustedHosts = [
      "cmr.earthdata.nasa.gov",
      "cumulus.asf.earthdatacloud.nasa.gov",
    ];
    return parsed.protocol === "https:" && trustedHosts.includes(parsed.hostname)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function openSource(url) {
  const safeUrl = safeSourceUrl(url);
  if (!safeUrl) {
    showToast("The source URL is missing or is not from an approved data provider.");
    return;
  }
  window.open(safeUrl, "_blank", "noopener,noreferrer");
}

function updateTemporalPair() {
  const pair = displayPair;
  if (pair.length !== 2) return;
  const [before, after] = pair;
  const active = Number($("#timelineSlider").value) === 1 ? after : before;
  const comparison = active.id === before.id ? after : before;
  if (active.assets.browse) $("#browseImage").src = active.assets.browse;
  else $("#browseImage").removeAttribute("src");
  if (comparison.assets.browse) $("#secondBrowseImage").src = comparison.assets.browse;
  else $("#secondBrowseImage").removeAttribute("src");
  $("#browseDateLabel").textContent = formatDate(active.acquired_at);
  $("#secondBrowseDateLabel").textContent = formatDate(comparison.acquired_at);
  $("#browseProduct").textContent = active.product_id;
  $("#secondBrowseProduct").textContent = comparison.product_id;
  $("#downloadBrowse").dataset.url = active.assets.browse ?? active.source_url;
  $("#downloadBrowse2").dataset.url = comparison.assets.browse ?? comparison.source_url;
  const hasBothBrowseImages = Boolean(active.assets.browse && comparison.assets.browse);
  $("#browseSideBySideButton").disabled = !hasBothBrowseImages;
  $("#browseSwipeButton").disabled = !hasBothBrowseImages;
  $("#browseSwipeSlider").disabled = !hasBothBrowseImages;
  $("#browseSwipePanel").hidden =
    !hasBothBrowseImages || $("#browseComparisonArea").dataset.view !== "swipe";
  if (hasBothBrowseImages) {
    $("#browseSwipeBefore").src = active.assets.browse;
    $("#browseSwipeAfter").src = comparison.assets.browse;
    $("#browseSwipeBeforeDate").textContent =
      `OBSERVATION A · ${formatDate(active.acquired_at)}`;
    $("#browseSwipeAfterDate").textContent =
      `OBSERVATION B · ${formatDate(comparison.acquired_at)}`;
  } else {
    $("#browseSwipeBefore").removeAttribute("src");
    $("#browseSwipeAfter").removeAttribute("src");
  }
  $("#browseComparisonArea").classList.toggle(
    "browse-comparison-ready",
    hasBothBrowseImages && compatiblePair(active, comparison),
  );
  $("#browseComparisonArea").classList.toggle(
    "browse-comparison-unmatched",
    hasBothBrowseImages && !compatiblePair(active, comparison),
  );
  if (!analysisResult) {
    $("#analysisSummary").textContent = hasBothBrowseImages
      ? compatiblePair(active, comparison)
        ? "Two same-tile source browse previews are ready for a visual swipe or side-by-side review. They are not pixel-aligned analytical rasters; quantitative change requires authenticated RTC products."
        : "Visual-only comparison: these CMR browse previews may cover different ground or geometry. They are not pixel-aligned measurements; quantitative change requires a compatible authenticated RTC pair."
      : "A pair is selected, but one or both products have no CMR browse preview. Open the source records or select another pair.";
  }
  $("#timelineStartLabel").textContent = formatDate(before.acquired_at);
  $("#timelineEndLabel").textContent = formatDate(after.acquired_at);
  const intervalDays = Math.round(
    (Date.parse(after.acquired_at) - Date.parse(before.acquired_at)) / 86400000,
  );
  $("#timelinePeriod").textContent = `${intervalDays} DAY${intervalDays === 1 ? "" : "S"} BETWEEN ACQUISITIONS`;
  globe?.setFootprint(active.geometry);
  studyMap?.setFootprint(active.geometry);
  setStep("Products", Boolean(before.assets.VV && after.assets.VV));
}

function setBrowseComparisonMode(mode) {
  const swipe = mode === "swipe";
  $("#browseComparisonArea").dataset.view = swipe ? "swipe" : "side-by-side";
  $("#browseSwipePanel").hidden = !swipe || !displayPair.length
    || !displayPair[0].assets.browse || !displayPair[1].assets.browse;
  $("#browseSideBySideButton").setAttribute("aria-pressed", String(!swipe));
  $("#browseSwipeButton").setAttribute("aria-pressed", String(swipe));
}

function updateBrowseSwipeControls() {
  const swipe = Number($("#browseSwipeSlider").value);
  $("#browseSwipeStage").style.setProperty("--browse-swipe-position", `${swipe}%`);
  $("#browseSwipeValue").textContent = `${swipe}%`;
}

function renderAnalysis(result) {
  analysisResult = result;
  const isLocalUpload = result.analysis_source === "local_geotiff_upload";
  const previewLabel = isLocalUpload ? "LOCAL GAMMA0 PREVIEW" : "ANALYTICAL RTC PREVIEW";
  $("#analysisMapPanel").hidden = false;
  const comparison = result.comparison_previews;
  $("#derivedComparisonPanel").hidden = !comparison;
  if (comparison) {
    const cacheKey = `?t=${Date.now()}`;
    const beforePreview = `${comparison.before_url}${cacheKey}`;
    const afterPreview = `${comparison.after_url}${cacheKey}`;
    $("#beforeRasterPreview").src = beforePreview;
    $("#afterRasterPreview").src = afterPreview;
    $("#beforeRasterSide").src = beforePreview;
    $("#afterRasterSide").src = afterPreview;
    const beforeDate = formatDate(result.before.acquired_at);
    const afterDate = formatDate(result.after.acquired_at);
    $("#beforeRasterDate").textContent = `BEFORE · ${beforeDate}`;
    $("#afterRasterDate").textContent = `AFTER · ${afterDate}`;
    $("#beforeRasterCaption").textContent = `BEFORE · ${beforeDate} · ${previewLabel}`;
    $("#afterRasterCaption").textContent = `AFTER · ${afterDate} · ${previewLabel}`;
    $("#rasterComparisonProvenance").textContent =
      `Shared 2–98% contrast stretch: ${comparison.shared_db_stretch[0].toFixed(2)} to ` +
      `${comparison.shared_db_stretch[1].toFixed(2)} dB · ${result.statistics.valid_pixels.toLocaleString()} ` +
      `common valid pixels · same grid and requested bounds. ${isLocalUpload ? "User-provided files; " : ""}` +
      "grayscale is a display stretch, not a change measurement.";
    $("#rasterSwipeSlider").value = "50";
    $("#afterRasterOpacity").value = "100";
    updateRasterComparisonControls();
    setRasterComparisonMode("swipe");
  }
  $("#changeMap").src = `${result.preview_url}?t=${Date.now()}`;
  $("#analysisMapGrid").textContent = `${result.grid.crs} · ${result.grid.width} × ${result.grid.height} px`;
  const stats = result.statistics;
  const layerButton = $("#toggleChangeLayer");
  const changeCells = Array.isArray(result.change_cells) ? result.change_cells : [];
  studyMap?.setChangeCells(changeCells);
  studyMap?.setChangeLayerVisible(changeCells.length > 0);
  layerButton.disabled = changeCells.length === 0;
  layerButton.setAttribute("aria-pressed", String(changeCells.length > 0));
  layerButton.setAttribute(
    "aria-label",
    changeCells.length ? "Hide derived radar change layer" : "Show derived radar change layer",
  );
  $("#changeLayerLegend").hidden = changeCells.length === 0;
  $("#changeCellReadout").textContent = changeCells.length
    ? `${changeCells.length.toLocaleString()} derived grid cells. Click a colored cell to inspect its median Δγ⁰ backscatter and valid-pixel fraction. Not displacement.`
    : "The analysis returned no valid grid cells to inspect.";
  $("#analysisStatistics").textContent =
    `DERIVED · median ${stats.median_delta_db.toFixed(2)} dB · ` +
    `mean ${stats.mean_delta_db.toFixed(2)} dB · σ ${stats.standard_deviation_db.toFixed(2)} dB · ` +
    `P10–P90 ${stats.p10_delta_db.toFixed(2)} to ${stats.p90_delta_db.toFixed(2)} dB · ` +
    `min/max ${stats.minimum_delta_db.toFixed(2)}/${stats.maximum_delta_db.toFixed(2)} dB · ` +
    `${stats.valid_pixels.toLocaleString()} valid pixels (${(100 * stats.valid_pixel_fraction).toFixed(1)}%)`;
  $("#analysisSummary").textContent =
    `Median gamma0 backscatter change: ${stats.median_delta_db.toFixed(2)} dB. ` +
    `The mapped ${changeCells.length} cell medians show spatial variation; this is backscatter intensity, not glacier displacement.`;
  $("#evidenceClassification").textContent = "DERIVED / RASTER ANALYSIS COMPLETED";
  $("#evidenceCopy").textContent =
    `${isLocalUpload ? "The user-provided" : "The quality-screened"} ${result.polarization} gamma0 comparison has a median change ` +
    `of ${stats.median_delta_db.toFixed(2)} dB over ${stats.valid_pixels.toLocaleString()} valid pixels. ` +
    `${changeCells.length} geographically indexed cells are available for inspection.`;
  $("#evidenceLimit").textContent = isLocalUpload
    ? "Not a movement measurement. User-file provenance and calibration are not independently verified; only NoData and non-finite pixels were excluded. Backscatter varies with surface state and viewing geometry."
    : "Not a movement measurement. Backscatter depends on surface state, moisture, snow, viewing geometry and residual processing error. Spatial spread is not a formal uncertainty estimate.";
  $("#workflowStatus").textContent = isLocalUpload
    ? "LOCAL GRID CHECK PASSED · ANALYSIS COMPLETED"
    : "QUALITY CHECK PASSED · ANALYSIS COMPLETED";
  $("#qualityAccess").textContent = isLocalUpload
    ? "User-provided GeoTIFFs were processed locally. Their source and calibration are not verified; no OPERA layover/shadow mask was applied."
    : "The selected source rasters and NASA checksum files were retrieved and validated. Grid, conversion metadata, and mask class 0 were checked.";
  setStep("Catalog", true);
  setStep("Products", true);
  setStep("Analysis", true);
  setStep("Report", true);
  showToast(isLocalUpload
    ? "Local gamma0 comparison is ready. Review the user-file provenance and limitations."
    : "Derived RTC gamma0 backscatter comparison is ready. See units and limitations.");
}

function updateRasterComparisonControls() {
  const swipe = Number($("#rasterSwipeSlider").value);
  const opacity = Number($("#afterRasterOpacity").value);
  $("#rasterSwipe").style.setProperty("--swipe-position", `${swipe}%`);
  $("#rasterAfterClip").style.opacity = String(opacity / 100);
  $("#afterRasterSide").style.opacity = String(opacity / 100);
  $("#rasterSwipeValue").textContent = `${swipe}%`;
  $("#afterRasterOpacityValue").textContent = `${opacity}%`;
}

function setRasterComparisonMode(mode) {
  const sideBySide = mode === "side-by-side";
  $("#rasterSwipe").hidden = sideBySide;
  $("#rasterSideBySide").hidden = !sideBySide;
  $("#compareSwipeButton").setAttribute("aria-pressed", String(!sideBySide));
  $("#compareSideBySideButton").setAttribute("aria-pressed", String(sideBySide));
}

async function runAnalysis() {
  if (selectedPair.length !== 2) return;
  const [before, after] = selectedPair;
  const sharedPolarizations = before.polarizations.filter((polarization) =>
    after.polarizations.includes(polarization),
  );
  const polarization = form.elements.polarization.value || sharedPolarizations[0];
  if (!sharedPolarizations.includes(polarization)) {
    showToast("Choose a polarization available in both selected products.");
    return;
  }
  const bounds = readBounds();
  $("#runAnalysisButton").disabled = true;
  $("#runAnalysisButton").textContent = "RETRIEVING RTC PRODUCTS…";
  $("#analysisReadiness").textContent = "Retrieving NASA OPERA GeoTIFFs and quality masks…";
  $("#workflowStatus").textContent = "RASTER DOWNLOAD / PROCESSING";
  setStep("Products", false);
  try {
    const result = await requestJson("/api/analysis/backscatter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        before_id: before.id,
        after_id: after.id,
        polarization,
        bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
      }),
    });
    renderAnalysis(result);
  } catch (error) {
    $("#workflowStatus").textContent = error.status === 424
      ? "AUTHENTICATION REQUIRED"
      : "ANALYSIS FAILED";
    $("#analysisReadiness").textContent = error.message;
    $("#analysisSummary").textContent = "No derived map is available; the analysis request did not complete.";
    $("#qualityAccess").textContent = error.message;
    setStep("Products", false);
    setStep("Analysis", false);
    setStep("Report", false);
    showToast(error.message);
  } finally {
    $("#runAnalysisButton").disabled =
      selectedPair.length !== 2 || earthdataTokenConfigured === false;
    $("#runAnalysisButton").textContent = "RUN REAL BACKSCATTER ANALYSIS";
  }
}

async function runLocalRasterAnalysis(event) {
  event.preventDefault();
  const formElement = $("#localRasterForm");
  const status = $("#localRasterStatus");
  const submitButton = formElement.querySelector('button[type="submit"]');
  const formData = new FormData(formElement);
  const beforeFile = formData.get("before_file");
  const afterFile = formData.get("after_file");
  if (!(beforeFile instanceof File) || !(afterFile instanceof File)) return;
  if (beforeFile.size > 100 * 1024 * 1024 || afterFile.size > 100 * 1024 * 1024) {
    status.dataset.state = "error";
    status.textContent = "Each GeoTIFF must be 100 MiB or smaller.";
    return;
  }
  const bounds = readBounds();
  for (const [name, value] of Object.entries(bounds)) {
    formData.append(name, String(value));
  }
  for (const name of ["before_date", "after_date"]) {
    if (!formData.get(name)) formData.delete(name);
  }

  submitButton.disabled = true;
  submitButton.textContent = "ANALYZING LOCAL FILES…";
  status.removeAttribute("data-state");
  status.textContent = "Uploading files to the loopback backend for temporary local processing…";
  $("#workflowStatus").textContent = "LOCAL GEO TIFF ANALYSIS";
  try {
    const result = await requestJson("/api/analysis/local-backscatter", {
      method: "POST",
      body: formData,
    });
    renderAnalysis(result);
    status.dataset.state = "ready";
    status.textContent =
      "Analysis complete. Inputs were temporary; user-supplied source and calibration are not verified.";
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = error.message;
    $("#workflowStatus").textContent = "LOCAL ANALYSIS FAILED";
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "ANALYZE LOCAL FILES";
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function sourceDialogHtml() {
  const records = scenes.map((scene) => `
    <li><strong>${escapeHtml(scene.acquired_at)}</strong> · ${escapeHtml(scene.platform)} · ${escapeHtml(scene.acquisition_mode)} subswath ${escapeHtml(scene.subswath)} · relative track ${escapeHtml(scene.relative_track)} · ${escapeHtml(scene.polarizations.join("/"))} · RTC ${escapeHtml(scene.processing_version ?? "version not reported")} · <code>${escapeHtml(scene.product_id)}</code> · <a href="${escapeHtml(scene.source_url)}" target="_blank" rel="noopener noreferrer">CMR record ↗</a></li>
  `).join("");
  return `
    <h3>Current live NASA CMR records</h3>
    <p>${searchRecord ? `${scenes.length} record(s) loaded from ${escapeHtml(searchRecord.source)}.` : "No live catalog records have been loaded yet."} Records shown here are returned by a live API request, not stored as observation fixtures.</p>
    ${records ? `<ul>${records}</ul>` : ""}
    <h3>Data access and credentials</h3>
    <p>CMR search metadata and browse imagery are publicly accessible. OPERA RTC-S1 raster downloads require an Earthdata Login token. The local-only credential control sends the token directly to the loopback backend, keeps it in process memory, and never saves it to browser storage or source files. Do not expose this development app to the public internet.</p>
    <h3>Product and license references</h3>
    <ul>
      <li><a href="https://cmr.earthdata.nasa.gov/search/site/collections/C2777436413-ASF" target="_blank" rel="noopener noreferrer">NASA CMR / OPERA RTC-S1 collection ↗</a></li>
      <li><a href="https://www.earthdata.nasa.gov/data/projects/opera" target="_blank" rel="noopener noreferrer">NASA OPERA project ↗</a></li>
      <li><a href="https://cumulus.asf.earthdatacloud.nasa.gov/PUBLIC/DATA/OPERA/ProductSpec_RTC-S1.pdf" target="_blank" rel="noopener noreferrer">OPERA RTC-S1 Product Specification ↗</a></li>
      <li><a href="https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice" target="_blank" rel="noopener noreferrer">Copernicus Sentinel Data Legal Notice ↗</a></li>
    </ul>
    <p><strong>Earth texture:</strong> a bundled equirectangular texture from the Three.js planet-texture examples. It is cartographic context, not a scientific image; the license of this exact image asset has not been independently verified. CMR outlines come from product geometry.</p>
  `;
}

function reportHtml(previewDataUrl = null) {
  const isLocalUpload = analysisResult?.analysis_source === "local_geotiff_upload";
  const pair = isLocalUpload
    ? ["before", "after"].map((period) => {
      const observation = analysisResult[period];
      return `<li><strong>${period === "before" ? "Before" : "After"} · ${escapeHtml(observation.acquired_at || "date not provided")}</strong> · User-provided local GeoTIFF · <code>${escapeHtml(observation.product_id)}</code> · source and processing history not independently verified</li>`;
    }).join("")
    : selectedPair.map((scene, index) => `
      <li><strong>${index === 0 ? "Before" : "After"} · ${escapeHtml(scene.acquired_at)}</strong> · ${escapeHtml(scene.platform)} · ${escapeHtml(scene.acquisition_mode)} subswath ${escapeHtml(scene.subswath)} · tile ${escapeHtml(scene.tile)} · relative track ${escapeHtml(scene.relative_track)} · orbit ${escapeHtml(scene.orbit_number ?? "not reported")} · RTC ${escapeHtml(scene.processing_version ?? "version not reported")} · <code>${escapeHtml(scene.product_id)}</code> · <a href="${escapeHtml(scene.source_url)}" target="_blank" rel="noopener noreferrer">source ↗</a></li>
    `).join("");
  const statistics = analysisResult?.statistics;
  const result = analysisResult
    ? `<p><strong>Derived result:</strong> median ${statistics.median_delta_db.toFixed(3)} dB; mean ${statistics.mean_delta_db.toFixed(3)} dB; standard deviation ${statistics.standard_deviation_db.toFixed(3)} dB; minimum/maximum ${statistics.minimum_delta_db.toFixed(3)}/${statistics.maximum_delta_db.toFixed(3)} dB; spatial P10–P90 ${statistics.p10_delta_db.toFixed(3)} to ${statistics.p90_delta_db.toFixed(3)} dB; ${statistics.valid_pixels.toLocaleString()} of ${statistics.total_pixels.toLocaleString()} pixels valid (${(statistics.valid_pixel_fraction * 100).toFixed(2)}%). Grid ${escapeHtml(analysisResult.grid.crs)}.</p><figure><img class="report-map" src="${escapeHtml(previewDataUrl || new URL(analysisResult.preview_url, location.href).href)}" alt="Derived gamma0 backscatter difference in decibels"><figcaption>DERIVED · After-minus-before γ⁰ backscatter, in dB. Not displacement.</figcaption></figure>`
    : "<p><strong>Result:</strong> no raster calculation is currently available. No change or displacement value is reported.</p>";
  const spatialCellCount = analysisResult?.change_cells?.length ?? 0;
  const spatialResult = analysisResult
    ? `<p>${spatialCellCount.toLocaleString()} geographically indexed cells summarize median Δγ⁰ backscatter in dB. Click colored cells on the map to inspect their WGS84 bounds and valid-pixel fraction. Blue indicates a lower return; amber indicates a higher return. This is not a displacement or uncertainty map.</p>`
    : "<p>No spatial change layer is available until the real raster analysis completes.</p>";
  const queryFilters = searchRecord?.filters
    ? `<pre>${escapeHtml(JSON.stringify(searchRecord.filters, null, 2))}</pre>`
    : "<p>No live NASA CMR query is loaded.</p>";
  const reproducibility = analysisResult
    ? `<ul><li>Requested WGS84 bounds: ${escapeHtml(JSON.stringify(analysisResult.coverage.requested_bounds_wgs84))}</li><li>Common valid-pixel fraction: ${(analysisResult.coverage.common_valid_pixel_fraction * 100).toFixed(2)}%</li><li>Software versions: ${escapeHtml(JSON.stringify(analysisResult.software))}</li><li>Processing versions: ${escapeHtml(analysisResult.before.processing_version || "not independently verified")} / ${escapeHtml(analysisResult.after.processing_version || "not independently verified")}</li><li>Dataset: ${escapeHtml(analysisResult.dataset)}</li></ul>`
    : "<p>Raster software and processing metadata are recorded only after a real analysis completes.</p>";
  const method = analysisResult
    ? `${escapeHtml(analysisResult.method)}${isLocalUpload ? "" : ` Source specification: <a href="https://cumulus.asf.earthdatacloud.nasa.gov/PUBLIC/DATA/OPERA/ProductSpec_RTC-S1.pdf" target="_blank" rel="noopener noreferrer">RTC-S1 Product Specification ↗</a>.`}`
    : "Select two real NASA OPERA RTC-S1 observations and run an analysis to record the processing method.";
  const qualityLimitations = isLocalUpload
    ? "Only NoData and non-finite pixels are excluded; no OPERA layover/shadow mask was supplied or applied. User-provided source, calibration, registration, and processing history are not independently verified. Spatial standard deviation and percentiles describe variation, not measurement uncertainty. Radiometric change is not surface displacement."
    : "Mask classes other than 0 and NoData are excluded. Standard deviation, extrema, and P10–P90 describe spatial variation, not measurement uncertainty. Radiometric change is not surface displacement: moisture, snow/melt, roughness, spacecraft and residual registration can affect the signal. No event attribution or movement claim is made.";
  const sourceAssets = analysisResult?.source_assets
    ? `<h3>Source raster assets and NASA checksum files</h3><ul>${["before", "after"].map((period) => `<li><strong>${period.toUpperCase()}</strong><ul><li><a href="${escapeHtml(analysisResult.source_assets[period].backscatter)}" target="_blank" rel="noopener noreferrer">${escapeHtml(analysisResult.polarization)} GeoTIFF ↗</a></li><li><a href="${escapeHtml(analysisResult.source_assets[period].backscatter_md5)}" target="_blank" rel="noopener noreferrer">NASA ${escapeHtml(analysisResult.polarization)} checksum ↗</a></li><li><a href="${escapeHtml(analysisResult.source_assets[period].mask)}" target="_blank" rel="noopener noreferrer">Quality mask GeoTIFF ↗</a></li><li><a href="${escapeHtml(analysisResult.source_assets[period].mask_md5)}" target="_blank" rel="noopener noreferrer">NASA mask checksum ↗</a></li></ul></li>`).join("")}</ul><p>Downloaded asset MD5 hashes were compared with these NASA checksum files before the calculation.</p>`
    : isLocalUpload
      ? "<p>User-uploaded files are not retained or linked as source assets. Dataset identifiers and acquisition dates were not independently verified.</p>"
      : "";
  return `
    <h3>1 / Study area</h3><p>Search bounds: ${escapeHtml(JSON.stringify(readBounds()))} in EPSG:4326. Center ${escapeHtml($("#globeReadoutCoordinates").textContent)}.</p>
    <h3>2–4 / Sensor, dates, source identifiers</h3>${pair ? `<ul>${pair}</ul>` : "<p>No compatible pair selected.</p>"}
    <h3>NASA CMR query filters</h3>${queryFilters}
    <h3>5 / Processing method</h3><p>${method}</p>
    <h3>6 / Detected backscatter differences</h3>${result}
    <h3>Spatial inspection layer</h3>${spatialResult}
    <h3>7–8 / Quality, uncertainty, interpretation</h3><p>${qualityLimitations}</p>
    <h3>9 / Reproducibility</h3><p>${isLocalUpload ? "The analysis records the declared units, polarization, optional dates, output grid, software versions, and requested WGS84 coverage. Input rasters are temporary and are not included in the exported record; retain the originals and their provenance separately." : "Every source product, acquisition time, platform, orbit, processing version, NASA CMR record, processing code path, units, output CRS, software versions, and requested WGS84 coverage are included in this session's loaded metadata."} Raster outputs are GeoTIFF plus display previews.</p>${reproducibility}
    ${analysisResult?.quality.cross_platform_warning ? `<p><strong>Acquisition caveat:</strong> ${escapeHtml(analysisResult.quality.cross_platform_warning)}</p>` : ""}
    ${sourceAssets}
  `;
}

function buildInvestigationRecord() {
  const bounds = readBounds();
  return {
    format: "terra-sight-investigation",
    version: 1,
    title: "TERRA SIGHT — Investigation record",
    exported_at: new Date().toISOString(),
    classification: analysisResult
      ? "DERIVED"
      : searchRecord?.count
        ? "MEASURED CATALOG METADATA"
        : "NO LIVE CATALOG RECORD",
    study_area: { name: studyName, center: studyCenter, bounds_wgs84: bounds },
    catalog_query: searchRecord ? {
      source: searchRecord.source,
      collection: searchRecord.collection,
      catalog_url: searchRecord.catalog_url,
      returned_count: searchRecord.count,
      filters: searchRecord.filters,
    } : null,
    selected_observations: selectedScenes(),
    analysis: analysisResult,
    methodology: analysisResult?.method
      ?? "OPERA RTC-S1 gamma0 backscatter comparison. This is not displacement or InSAR.",
    limitations: [
      "Browse previews are not scientific comparison inputs.",
      "Backscatter intensity differences do not by themselves establish ground movement.",
      "Descriptive spatial statistics are not measurement uncertainty.",
      "No InSAR, coherence, or glacier velocity analysis is implemented.",
      ...(analysisResult?.analysis_source === "local_geotiff_upload"
        ? [
          "Local GeoTIFF provenance and calibration are user-declared and not independently verified.",
          "No OPERA layover/shadow mask or source checksums are applied to local uploads.",
          "Original uploaded inputs are temporary and are not included in the exported record.",
        ]
        : []),
    ],
  };
}

function downloadTextFile(content, filename, mediaType) {
  const objectUrl = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function exportInvestigation() {
  const record = buildInvestigationRecord();
  downloadTextFile(
    JSON.stringify(record, null, 2),
    `terra-sight-investigation-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json",
  );
  showToast("TERRA SIGHT investigation JSON exported with loaded sources and limitations.");
}

async function reportPreviewDataUrl() {
  if (!analysisResult) return null;
  const response = await fetch(analysisResult.preview_url);
  if (!response.ok) {
    throw new Error(`The derived map preview could not be loaded (HTTP ${response.status}).`);
  }
  const preview = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The derived map preview could not be embedded."));
    reader.readAsDataURL(preview);
  });
}

async function exportHtmlReport() {
  try {
    const previewDataUrl = await reportPreviewDataUrl();
    const content = `<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <title>TERRA SIGHT — Investigation report</title>
      <style>
        body{max-width:900px;margin:40px auto;padding:0 24px;color:#18343a;background:#fbfaf6;font:16px/1.65 Arial,sans-serif}
        header{padding-bottom:18px;border-bottom:3px solid #e27c53}h1{margin:0;color:#0c303c;font-size:34px}
        header p{margin:4px 0;color:#53716b;letter-spacing:.08em}h3{margin:26px 0 8px;color:#225c60;font-size:17px}
        a{color:#347b78;overflow-wrap:anywhere}code{overflow-wrap:anywhere}li{margin:8px 0}
        figure{margin:22px 0}figure img{display:block;max-width:100%;max-height:560px;margin:auto}figcaption{color:#617870;font-size:13px;text-align:center}
        @media print{body{margin:0 auto}a{color:inherit;text-decoration:none}}
      </style></head><body><header><h1>TERRA SIGHT</h1><p>SEE WHAT THE EARTH HIDES · SCIENTIFIC INVESTIGATION</p></header>
      <main>${reportHtml(previewDataUrl)}</main><footer><p>Generated ${escapeHtml(new Date().toISOString())}. No simulated measurement is included.</p></footer></body></html>`;
    downloadTextFile(
      content,
      `terra-sight-report-${new Date().toISOString().slice(0, 10)}.html`,
      "text/html",
    );
    showToast("Portable HTML investigation report downloaded.");
  } catch (error) {
    showToast(`Could not export the HTML report: ${error.message}`);
  }
}

function readSavedReports() {
  const stored = localStorage.getItem(SAVED_REPORTS_KEY);
  if (!stored) return [];
  const reports = JSON.parse(stored);
  if (
    !Array.isArray(reports)
    || reports.some((report) =>
      !report
      || typeof report.id !== "string"
      || typeof report.saved_at !== "string"
      || !Number.isFinite(Date.parse(report.saved_at))
      || report.record?.format !== "terra-sight-investigation"
      || report.record?.version !== 1
      || typeof report.record?.study_area?.name !== "string"
      || typeof report.record?.classification !== "string"
    )
  ) {
    throw new Error("Saved report data is not a recognized TERRA SIGHT record.");
  }
  return reports;
}

function renderSavedReports() {
  const container = $("#savedReports");
  let reports;
  try {
    reports = readSavedReports();
  } catch (error) {
    container.replaceChildren();
    const message = document.createElement("p");
    message.className = "saved-reports-empty";
    message.setAttribute("role", "alert");
    message.textContent = `Saved reports could not be read: ${error.message}`;
    container.append(message);
    return;
  }
  container.replaceChildren();
  if (!reports.length) {
    const empty = document.createElement("p");
    empty.className = "saved-reports-empty";
    empty.textContent = "Saved investigations appear here on this device.";
    container.append(empty);
    return;
  }
  for (const report of reports) {
    const row = document.createElement("div");
    row.className = "saved-report";
    row.setAttribute("role", "listitem");
    const label = document.createElement("span");
    const dateLabel = new Intl.DateTimeFormat("en", { dateStyle: "medium" })
      .format(new Date(report.saved_at));
    label.textContent =
      `${report.record.study_area.name} · ${dateLabel} · ${report.record.classification}`;
    const actions = document.createElement("div");
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Download JSON";
    download.dataset.reportAction = "download";
    download.dataset.reportId = report.id;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.dataset.reportAction = "remove";
    remove.dataset.reportId = report.id;
    actions.append(download, remove);
    row.append(label, actions);
    container.append(row);
  }
}

function saveInvestigationReport() {
  try {
    const reports = readSavedReports();
    const record = buildInvestigationRecord();
    reports.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      saved_at: new Date().toISOString(),
      record,
    });
    localStorage.setItem(SAVED_REPORTS_KEY, JSON.stringify(reports.slice(0, MAX_SAVED_REPORTS)));
    renderSavedReports();
    showToast("Investigation saved in this browser on this device.");
  } catch (error) {
    showToast(`Could not save this investigation: ${error.message}`);
  }
}

function handleSavedReportAction(event) {
  const button = event.target.closest("button[data-report-action]");
  if (!button) return;
  try {
    const reports = readSavedReports();
    const report = reports.find((item) => item.id === button.dataset.reportId);
    if (!report) throw new Error("The selected saved report is no longer available.");
    if (button.dataset.reportAction === "download") {
      downloadTextFile(
        JSON.stringify(report.record, null, 2),
        `terra-sight-investigation-${report.saved_at.slice(0, 10)}.json`,
        "application/json",
      );
    } else {
      localStorage.setItem(
        SAVED_REPORTS_KEY,
        JSON.stringify(reports.filter((item) => item.id !== report.id)),
      );
      renderSavedReports();
      showToast("Saved report removed from this device.");
    }
  } catch (error) {
    showToast(`Could not update saved reports: ${error.message}`);
  }
}

function saveStudyConfiguration() {
  try {
    localStorage.setItem(STUDY_STORAGE_KEY, JSON.stringify({
      name: studyName,
      center: studyCenter,
      form: Object.fromEntries(new FormData(form).entries()),
    }));
    showToast("Study area and catalog filters saved in this browser.");
  } catch (error) {
    showToast(`Could not save this study in browser storage: ${error.message}`);
  }
}

function restoreStudyConfiguration() {
  let stored;
  let legacyStorage = false;
  try {
    stored = localStorage.getItem(STUDY_STORAGE_KEY);
    if (!stored) {
      stored = localStorage.getItem(LEGACY_STUDY_STORAGE_KEY);
      legacyStorage = Boolean(stored);
    }
  } catch (error) {
    showToast(`Browser storage is unavailable: ${error.message}`);
    return;
  }
  if (!stored) return;
  try {
    const saved = JSON.parse(stored);
    for (const [name, value] of Object.entries(saved.form ?? {})) {
      if (form.elements[name]) form.elements[name].value = value;
    }
    if (
      saved.center
      && Number.isFinite(saved.center.latitude)
      && Number.isFinite(saved.center.longitude)
    ) {
      studyCenter = saved.center;
    }
    if (typeof saved.name === "string") {
      studyName = saved.name;
      $("#placeSearch").value = studyName;
      $("#globeStudyName").textContent = studyName;
      $("#globeReadoutName").textContent = studyName.split(",")[0];
      $("#globeStudyCoordinates").textContent = formatCoordinates(studyCenter.latitude, studyCenter.longitude);
      $("#globeReadoutCoordinates").textContent = formatCoordinates(studyCenter.latitude, studyCenter.longitude);
    }
    if (legacyStorage) localStorage.setItem(STUDY_STORAGE_KEY, stored);
  } catch (error) {
    showToast(`Saved study data could not be restored: ${error.message}`);
  }
}

function methodologyHtml() {
  return `
    <h3>Analysis workflow</h3>
    <p>The backend queries NASA CMR for OPERA RTC-S1 scenes and retrieves the selected polarization GeoTIFF plus the matching quality mask. The products must be from the same RTC burst tile and acquisition mode; their grids are checked and never silently resampled.</p>
    <h3>Derived quantity</h3>
    <p>OPERA RTC-S1 provides terrain-corrected γ⁰ backscatter. For each common valid pixel, the pipeline computes <code>10·log10(after) − 10·log10(before)</code>, reported in dB. OPERA mask class 0 is retained; invalid, layover and shadow pixels are excluded. The median and P10–P90 spatial distribution are summarized.</p>
    <h3>Interpretation limits</h3>
    <ul>
      <li>This is backscatter intensity change, not displacement, velocity, coherence or an interferogram.</li>
      <li>Wetness, snow, melt, roughness, incidence/viewing geometry, instrument differences and residual geolocation error can change backscatter.</li>
      <li>Spatial percentiles are not a formal uncertainty estimate. No causal attribution is attempted.</li>
      <li>InSAR requires suitable phase-preserving SLC pairs and coherence/geometry checks; this RTC-S1 comparison does not provide InSAR.</li>
      <li>Raster downloads require an Earthdata Login token held only in the backend environment.</li>
    </ul>
  `;
}

function openDetail(title, html) {
  $("#dialogTitle").textContent = title;
  $("#dialogContent").innerHTML = html;
  $("#detailDialog").showModal();
}

function assistantAnswer(question) {
  const query = question.toLowerCase();
  if (!scenes.length && !analysisResult) return "No live catalog records or local analysis results are loaded. Search NASA CMR or analyze your own GeoTIFF pair first; I do not have cached or fabricated observations.";
  if (/(where|which area|region|spatial)/.test(query)) {
    if (!analysisResult?.change_cells?.length) {
      return "No georeferenced change layer is loaded. CMR footprints show acquisition coverage only; run the authenticated RTC raster comparison before interpreting spatial backscatter differences.";
    }
    const largestCells = [...analysisResult.change_cells]
      .sort((a, b) => Math.abs(b.median_delta_db) - Math.abs(a.median_delta_db))
      .slice(0, 3)
      .map((cell) => {
        const [west, south, east, north] = cell.bounds_wgs84;
        const center = formatCoordinates((south + north) / 2, (west + east) / 2);
        const delta = Number(cell.median_delta_db);
        return `${center}: ${delta > 0 ? "+" : ""}${delta.toFixed(2)} dB`;
      });
    return `Largest absolute cell-median backscatter differences are ${largestCells.join("; ")}. These are RTC gamma-zero intensity differences, not movement hotspots or formal uncertainty estimates.`;
  }
  if (/(motion|displacement|velocity|insar|move)/.test(query)) {
    return "This workflow compares OPERA RTC-S1 gamma-zero backscatter intensity. It does not measure glacier velocity or displacement. InSAR needs compatible phase-preserving SLC pairs and a separate coherence/geometry analysis.";
  }
  if (/(reliable|uncertainty|confidence|quality)/.test(query)) {
    return analysisResult
      ? analysisResult.analysis_source === "local_geotiff_upload"
        ? `The user-provided rasters share a matching grid. ${analysisResult.statistics.valid_pixels.toLocaleString()} of ${analysisResult.statistics.total_pixels.toLocaleString()} pixels remain (${(analysisResult.statistics.valid_pixel_fraction * 100).toFixed(1)}%). Only NoData and non-finite pixels were excluded; no OPERA quality mask was applied, and the source and calibration are not verified. These statistics are not formal measurement uncertainty.`
        : `The output retains only pixels valid in both RTC masks (class 0) and requires identical CRS, transform, and dimensions. ${analysisResult.statistics.valid_pixels.toLocaleString()} of ${analysisResult.statistics.total_pixels.toLocaleString()} pixels remain (${(analysisResult.statistics.valid_pixel_fraction * 100).toFixed(1)}%). Standard deviation and P10–P90 describe spatial variation, not formal measurement uncertainty. Surface-state and geometry effects remain.`
      : "No raster quality assessment has run yet. The analysis requires authenticated RTC GeoTIFFs and masks, then checks the exact grid and valid class-0 overlap. It will not report a confidence score from browse images.";
  }
  if (/(what changed|result|calculate|backscatter)/.test(query)) {
    return analysisResult
      ? `The derived ${analysisResult.polarization} gamma-zero backscatter difference (${analysisResult.dataset}) has median ${analysisResult.statistics.median_delta_db.toFixed(2)} dB, mean ${analysisResult.statistics.mean_delta_db.toFixed(2)} dB, spatial standard deviation ${analysisResult.statistics.standard_deviation_db.toFixed(2)} dB, and spatial P10–P90 ${analysisResult.statistics.p10_delta_db.toFixed(2)} to ${analysisResult.statistics.p90_delta_db.toFixed(2)} dB. This is intensity change, not displacement or causal attribution.`
      : "No raster-derived result is loaded. CMR provides real acquisition metadata, but the raster comparison runs only after the backend retrieves the actual OPERA GeoTIFFs and quality masks.";
  }
  if (/(date|satellite|source|catalog|data|observation)/.test(query)) {
    const pair = selectedScenes();
    if (analysisResult?.analysis_source === "local_geotiff_upload" && !pair.length) {
      return `The current analysis uses user-provided local GeoTIFFs. Before date: ${analysisResult.before.acquired_at || "not provided"}; after date: ${analysisResult.after.acquired_at || "not provided"}. The files' source and acquisition metadata were not independently verified.`;
    }
    if (!pair.length) return `${scenes.length} live CMR scene(s) are loaded. Select two compatible scenes to inspect their dates and product identifiers.`;
    return pair.map((scene) => `${scene.platform} at ${scene.acquired_at}; ${scene.acquisition_mode} subswath ${scene.subswath}, tile ${scene.tile}, relative track ${scene.relative_track ?? "not reported"}, orbit ${scene.orbit_number ?? "not reported"}; source ID ${scene.id}; NASA CMR record: ${scene.source_url}.`).join(" ");
  }
  return "I answer only from the loaded NASA CMR records, this processing method, and any derived raster result. Ask about the product IDs, dates, gamma-zero backscatter, quality mask, uncertainty, or displacement limitations.";
}

function appendAssistantMessage(text, isUser) {
  const message = document.createElement("div");
  message.className = `assistant-message${isUser ? " user-message" : ""}`;
  if (!isUser) {
    const avatar = document.createElement("span");
    avatar.className = "assistant-avatar";
    avatar.textContent = "✳";
    message.append(avatar);
  }
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  message.append(paragraph);
  $("#assistantMessages").append(message);
  message.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function submitQuestion(question) {
  const trimmed = question.trim();
  if (!trimmed) return;
  appendAssistantMessage(trimmed, true);
  appendAssistantMessage(assistantAnswer(trimmed), false);
  $("#assistantInput").value = "";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  searchCatalog();
});
$("#sceneFilter").addEventListener("input", () => {
  catalogPage = 0;
  renderCatalog();
});
$("#catalogPreviousPage").addEventListener("click", () => {
  catalogPage = Math.max(0, catalogPage - 1);
  renderCatalog();
});
$("#earthdataCredentialForm").addEventListener("submit", configureEarthdataToken);
$("#forgetEarthdataToken").addEventListener("click", forgetEarthdataToken);
$("#openEarthdataSetup").addEventListener("click", () => {
  const setup = $("#credentialSetup");
  setup.open = true;
  setup.scrollIntoView({ behavior: "smooth", block: "center" });
  $("#earthdataToken").focus({ preventScroll: true });
});
$("#catalogNextPage").addEventListener("click", () => {
  catalogPage += 1;
  renderCatalog();
});
$("#clearSelection").addEventListener("click", () => {
  selectedIds.clear();
  clearAnalysisResult();
  renderCatalog();
});
$("#runAnalysisButton").addEventListener("click", runAnalysis);
$("#localRasterForm").addEventListener("submit", runLocalRasterAnalysis);
$("#runTemporalProfile").addEventListener("click", runTemporalProfile);
$("#browseSideBySideButton").addEventListener("click", () =>
  setBrowseComparisonMode("side-by-side"),
);
$("#browseSwipeButton").addEventListener("click", () =>
  setBrowseComparisonMode("swipe"),
);
$("#browseSwipeSlider").addEventListener("input", updateBrowseSwipeControls);
$("#openCatalog").addEventListener("click", () => openSource(searchRecord?.catalog_url));
$("#retryCatalog").addEventListener("click", searchCatalog);
$("#sourcesButton").addEventListener("click", () => openDetail("Data sources & provenance", sourceDialogHtml()));
$("#reportButton").addEventListener("click", () => openDetail("Scientific investigation report", reportHtml()));
$("#methodologyButton").addEventListener("click", () => openDetail("Methodology & limitations", methodologyHtml()));
$("#methodologyButton2").addEventListener("click", () => openDetail("Methodology & limitations", methodologyHtml()));
$("#limitationsButton").addEventListener("click", () => openDetail("Methodology & limitations", methodologyHtml()));
$("#dialogClose").addEventListener("click", () => $("#detailDialog").close());
$("#assistantButton").addEventListener("click", () => $("#assistantDialog").showModal());
$("#assistantClose").addEventListener("click", () => $("#assistantDialog").close());
$("#onboardingButton").addEventListener("click", () => $("#onboardingDialog").showModal());
$("#onboardingClose").addEventListener("click", () => $("#onboardingDialog").close());
$("#onboardingContinue").addEventListener("click", () => $("#onboardingDialog").close());
$("#applyPlace").addEventListener("click", () => chooseStudyLocation($("#placeSearch").value));
$("#placeSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    chooseStudyLocation($("#placeSearch").value);
  }
});
$("#saveStudy").addEventListener("click", saveStudyConfiguration);
$("#exportReport").addEventListener("click", exportInvestigation);
$("#saveReport").addEventListener("click", saveInvestigationReport);
$("#exportHtmlReport").addEventListener("click", exportHtmlReport);
$("#savedReports").addEventListener("click", handleSavedReportAction);
$("#mapZoomIn").addEventListener("click", () => studyMap?.zoom(1.5));
$("#mapZoomOut").addEventListener("click", () => studyMap?.zoom(1 / 1.5));
$("#mapFit").addEventListener("click", () => studyMap?.fitBounds(readBounds()));
$("#rasterSwipeSlider").addEventListener("input", updateRasterComparisonControls);
$("#afterRasterOpacity").addEventListener("input", updateRasterComparisonControls);
$("#compareSwipeButton").addEventListener("click", () => setRasterComparisonMode("swipe"));
$("#compareSideBySideButton").addEventListener("click", () => setRasterComparisonMode("side-by-side"));
$("#toggleChangeLayer").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const visible = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(visible));
  button.setAttribute(
    "aria-label",
    visible ? "Hide derived radar change layer" : "Show derived radar change layer",
  );
  studyMap?.setChangeLayerVisible(visible);
});
$("#assistantForm").addEventListener("submit", (event) => {
  event.preventDefault();
  submitQuestion($("#assistantInput").value);
});
document.querySelectorAll("[data-question]").forEach((button) => {
  button.addEventListener("click", () => submitQuestion(button.dataset.question));
});

$("#downloadBrowse").addEventListener("click", () => openSource($("#downloadBrowse").dataset.url));
$("#downloadBrowse2").addEventListener("click", () => openSource($("#downloadBrowse2").dataset.url));
$("#expandImage").addEventListener("click", () => openSource($("#downloadBrowse").dataset.url));
$("#timelineSlider").addEventListener("input", updateTemporalPair);
$("#toggleOrbits").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const showing = button.getAttribute("aria-pressed") === "true";
  button.setAttribute("aria-pressed", String(!showing));
  globe?.setOrbitVisible(!showing);
});
$("#resetGlobe").addEventListener("click", () => {
  globe?.focus(studyCenter.latitude, studyCenter.longitude);
  globe?.setFootprint(selectedPair[0]?.geometry ?? null);
  showToast("Earth view recentered on the selected study area.");
});
$("#playTimeline").addEventListener("click", (event) => {
  const button = event.currentTarget;
  if (playTimer) {
    stopTimelinePlayback();
    return;
  }
  button.textContent = "Ⅱ";
  button.setAttribute("aria-label", "Pause timeline");
  playTimer = setInterval(() => {
    $("#timelineSlider").value = String(1 - Number($("#timelineSlider").value));
    updateTemporalPair();
  }, 1600);
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#sceneFilter").focus();
  }
});
document.querySelectorAll(".primary-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".primary-nav a").forEach((item) =>
      item.removeAttribute("aria-current"),
    );
    link.setAttribute("aria-current", "page");
  });
});
$("#detailDialog").addEventListener("click", (event) => {
  if (event.target === $("#detailDialog")) $("#detailDialog").close();
});
$("#assistantDialog").addEventListener("click", (event) => {
  if (event.target === $("#assistantDialog")) $("#assistantDialog").close();
});
$("#onboardingDialog").addEventListener("click", (event) => {
  if (event.target === $("#onboardingDialog")) $("#onboardingDialog").close();
});
$("#assistantDialog").addEventListener("close", () => {
  stopTimelinePlayback();
});

form.elements.acquisition_mode.addEventListener("change", updateSubswathAvailability);
form.addEventListener("input", invalidateCatalog);
form.addEventListener("change", invalidateCatalog);
form.addEventListener("change", () => {
  studyMap?.setBounds(readBounds());
  studyMap?.draw();
});
setDefaultDateRange();
restoreStudyConfiguration();
updateSubswathAvailability();
renderSavedReports();
async function loadGlobe() {
  try {
    const { createGlobe } = await import("./globe.js");
    globe = createGlobe($("#earthCanvas"), handleLocationSelection);
  } catch (error) {
    console.error("Could not load the 3D Earth module.", error);
    const state = $("#globeLoadState");
    if (state) state.textContent = "3D GLOBE MODULE FAILED TO LOAD";
  }
}
loadGlobe();
studyMap = createStudyMap($("#studyMap"), {
  bounds: readBounds(),
  center: studyCenter,
  onChangeCellSelected: inspectChangeCell,
  onLocationSelected: handleLocationSelection,
});
$("#mapCoordinates").textContent = `${formatCoordinates(studyCenter.latitude, studyCenter.longitude)} · WGS84`;
checkAnalysisAccess();
searchCatalog();
