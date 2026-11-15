import { parseCmrGranule } from "../../src/catalog.js";

const CMR_BASE = "https://cmr.earthdata.nasa.gov/search";
const COLLECTION = "OPERA_L2_RTC-S1_V1";
const CMR_PAGE_SIZE = 2000;
const MAX_CATALOG_RESULTS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const VALID_PLATFORMS = new Set(["S1A", "S1B", "S1C"]);
const VALID_POLARIZATIONS = new Set(["VV", "VH"]);
const VALID_MODES = new Set(["IW", "EW", "SM", "WV"]);
const VALID_DIRECTIONS = new Set(["ASCENDING", "DESCENDING"]);

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 422;
  return error;
}

function queryValue(query, name) {
  const value = query[name];
  if (Array.isArray(value)) throw badRequest(`${name} must be provided only once.`);
  return typeof value === "string" ? value.trim() : "";
}

function numericValue(query, name, minimum, maximum) {
  const raw = queryValue(query, name);
  if (!raw) throw badRequest(`${name} is required.`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw badRequest(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`${name} must be a valid YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw badRequest(`${name} must be a valid YYYY-MM-DD date.`);
  }
  return parsed;
}

function validateQuery(query) {
  const west = numericValue(query, "west", -180, 180);
  const south = numericValue(query, "south", -90, 90);
  const east = numericValue(query, "east", -180, 180);
  const north = numericValue(query, "north", -90, 90);
  if (west >= east || south >= north) {
    throw badRequest("Bounds must be ordered west < east and south < north.");
  }
  if (east - west > 20 || north - south > 20) {
    throw badRequest("Search areas are limited to 20 degrees per axis.");
  }

  const startDate = queryValue(query, "start_date");
  const endDate = queryValue(query, "end_date");
  const start = validDate(startDate, "start_date");
  const end = validDate(endDate, "end_date");
  if (start > end) throw badRequest("start_date must precede end_date.");
  if ((end - start) / 86_400_000 > 366) {
    throw badRequest("Date windows may not exceed one year.");
  }

  const platform = queryValue(query, "platform");
  const polarization = queryValue(query, "polarization");
  const relativeTrackValue = queryValue(query, "relative_track");
  const acquisitionMode = queryValue(query, "acquisition_mode");
  const subswathValue = queryValue(query, "subswath");
  const orbitDirection = queryValue(query, "orbit_direction");
  const relativeTrack = relativeTrackValue ? Number(relativeTrackValue) : null;
  const subswath = subswathValue ? Number(subswathValue) : null;

  if (platform && !VALID_PLATFORMS.has(platform)) {
    throw badRequest("platform must be S1A, S1B, or S1C.");
  }
  if (polarization && !VALID_POLARIZATIONS.has(polarization)) {
    throw badRequest("polarization must be VV or VH.");
  }
  if (acquisitionMode && !VALID_MODES.has(acquisitionMode)) {
    throw badRequest("acquisition_mode is not supported.");
  }
  if (relativeTrack !== null && (!Number.isInteger(relativeTrack) || relativeTrack < 1 || relativeTrack > 175)) {
    throw badRequest("relative_track must be an integer from 1 to 175.");
  }
  if (subswath !== null && (!Number.isInteger(subswath) || subswath < 1 || subswath > 3)) {
    throw badRequest("subswath must be an integer from 1 to 3.");
  }
  if (subswath !== null && acquisitionMode && !["IW", "EW"].includes(acquisitionMode)) {
    throw badRequest("Subswath filtering is available only for IW and EW acquisitions.");
  }
  if (orbitDirection && !VALID_DIRECTIONS.has(orbitDirection)) {
    throw badRequest("orbit_direction must be ASCENDING or DESCENDING.");
  }

  return {
    west,
    south,
    east,
    north,
    startDate,
    endDate,
    platform: platform || null,
    polarization: polarization || null,
    relativeTrack,
    acquisitionMode: acquisitionMode || null,
    subswath,
    orbitDirection: orbitDirection || null,
  };
}

function buildCatalogUrl(query) {
  const params = new URLSearchParams({
    short_name: COLLECTION,
    bounding_box: `${query.west},${query.south},${query.east},${query.north}`,
    temporal: `${query.startDate}T00:00:00Z,${query.endDate}T23:59:59Z`,
    page_size: String(CMR_PAGE_SIZE),
  });
  return `${CMR_BASE}/granules.json?${params}`;
}

async function fetchCmrPage(url, searchAfter) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          ...(searchAfter ? { "CMR-Search-After": searchAfter } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 1) {
        throw new Error(`NASA CMR returned HTTP ${response.status}.`);
      }
      lastError = new Error(`NASA CMR returned HTTP ${response.status}.`);
    } catch (error) {
      if (error.statusCode) throw error;
      lastError = error;
      if (attempt === 1) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`NASA CMR request failed: ${lastError?.message ?? "unknown error"}`);
}

function matchesFilters(scene, query) {
  return (!query.platform || scene.platform === query.platform)
    && (!query.polarization || scene.polarizations.includes(query.polarization))
    && (query.relativeTrack === null || scene.relative_track === query.relativeTrack)
    && (!query.acquisitionMode || scene.acquisition_mode === query.acquisitionMode)
    && (query.subswath === null
      || (["IW", "EW"].includes(scene.acquisition_mode) && scene.subswath === query.subswath))
    && (!query.orbitDirection || scene.orbit_direction === query.orbitDirection);
}

async function searchScenes(query) {
  const catalogUrl = buildCatalogUrl(query);
  const entries = new Map();
  let cmrTotalHits = null;
  let searchAfter = null;
  let catalogComplete = true;

  while (entries.size < MAX_CATALOG_RESULTS) {
    const response = await fetchCmrPage(catalogUrl, searchAfter);
    if (cmrTotalHits === null) {
      const total = Number(response.headers.get("CMR-Hits"));
      cmrTotalHits = Number.isFinite(total) ? total : null;
    }
    const payload = await response.json();
    const pageEntries = payload?.feed?.entry ?? [];
    if (!Array.isArray(pageEntries) || pageEntries.length === 0) break;
    for (const entry of pageEntries) {
      const key = entry.id || entry.producer_granule_id;
      if (key) entries.set(key, entry);
    }
    searchAfter = response.headers.get("CMR-Search-After");
    if (!searchAfter) break;
    if (entries.size >= MAX_CATALOG_RESULTS) catalogComplete = false;
  }

  const scenes = [...entries.values()]
    .map(parseCmrGranule)
    .filter((scene) => scene && matchesFilters(scene, query))
    .sort((a, b) => a.acquired_at.localeCompare(b.acquired_at));
  const filters = {
    bounds_wgs84: [query.west, query.south, query.east, query.north],
    start_date: query.startDate,
    end_date: query.endDate,
    platform: query.platform,
    polarization: query.polarization,
    relative_track: query.relativeTrack,
    acquisition_mode: query.acquisitionMode,
    subswath: query.subswath,
    orbit_direction: query.orbitDirection,
  };
  const result = {
    source: "NASA CMR / Alaska Satellite Facility DAAC",
    collection: COLLECTION,
    catalog_url: catalogUrl,
    count: scenes.length,
    cmr_total_hits: cmrTotalHits,
    catalog_complete: catalogComplete,
    scenes,
    filters,
  };

  while (scenes.length && Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES) {
    scenes.shift();
    result.count = scenes.length;
    result.catalog_complete = false;
  }
  return result;
}

export default async function search(request, response) {
  response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ detail: "Method not allowed." });
  }

  try {
    const query = validateQuery(request.query ?? {});
    const result = await searchScenes(query);
    return response.status(200).json(result);
  } catch (error) {
    const statusCode = error.statusCode ?? 502;
    return response.status(statusCode).json({
      detail: statusCode === 422
        ? error.message
        : "Live NASA CMR search failed. Please retry shortly.",
    });
  }
}
