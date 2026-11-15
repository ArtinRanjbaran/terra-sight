const CMR_BASE = "https://cmr.earthdata.nasa.gov/search";
const COLLECTION = "OPERA_L2_RTC-S1_V1";
const DATASET =
  "OPERA Radiometric Terrain Corrected SAR Backscatter from Sentinel-1 validated product (Version 1)";

function publicAssets(links = []) {
  const assets = {};
  const browseCandidates = [];
  const polarizations = new Set();
  for (const link of links) {
    const href = link?.href ?? "";
    if (!href.startsWith("https://")) continue;
    const filename = href.split("/").pop().toLowerCase();
    if (filename.includes("_browse_low-res.png")) browseCandidates.push([0, href]);
    else if (filename.includes("_browse_thumbnail.png")) browseCandidates.push([1, href]);
    else if (filename.includes("_browse.png")) browseCandidates.push([2, href]);
    else if ((link.title ?? "").toLowerCase().endsWith(".png")) {
      browseCandidates.push([3, href]);
    }
    if (filename.endsWith("_vv.tif")) polarizations.add("VV");
    if (filename.endsWith("_vh.tif")) polarizations.add("VH");
  }
  if (browseCandidates.length) {
    assets.browse = browseCandidates.sort((a, b) => a[0] - b[0])[0][1];
  }
  return { assets, polarizations: [...polarizations] };
}

export function parseCmrGranule(entry) {
  const productId = entry?.producer_granule_id ?? entry?.title ?? "";
  if (!productId.startsWith("OPERA_L2_RTC-S1_")) return null;

  const tileMatch = /_(T\d{3}-\d{6})-([A-Z]{2}\d)_/.exec(productId);
  const platformMatch = /_(S1[ABC])_\d+_v[\d.]+/.exec(productId);
  const acquiredAt = entry.time_start;
  if (!tileMatch || !platformMatch || !acquiredAt) return null;

  const mode = tileMatch[2];
  const { assets, polarizations } = publicAssets(entry.links);
  const rings = [];
  for (const polygon of entry.polygons ?? []) {
    for (const rawRing of polygon ?? []) {
      const values = typeof rawRing === "string" ? rawRing.trim().split(/\s+/) : rawRing;
      const numbers = values?.map(Number);
      if (!numbers || numbers.length < 6 || numbers.length % 2 !== 0 || numbers.some((value) => !Number.isFinite(value))) {
        continue;
      }
      const points = [];
      for (let index = 0; index < numbers.length; index += 2) {
        points.push([numbers[index + 1], numbers[index]]);
      }
      if (
        points[0][0] !== points.at(-1)[0]
        || points[0][1] !== points.at(-1)[1]
      ) {
        points.push(points[0]);
      }
      rings.push(points);
    }
  }

  const geometry = rings.length > 1
    ? { type: "MultiPolygon", coordinates: rings.map((ring) => [ring]) }
    : { type: "Polygon", coordinates: rings };
  const id = String(entry.id ?? "");

  return {
    id,
    product_id: productId,
    dataset: entry.dataset_id || DATASET,
    acquired_at: acquiredAt,
    end_time: entry.time_end ?? null,
    platform: platformMatch[1],
    instrument: "C-SAR",
    mode,
    acquisition_mode: mode.slice(0, -1),
    subswath: Number(mode.at(-1)),
    processing_version: /_v([\d.]+)$/.exec(productId)?.[1] ?? null,
    tile: tileMatch[1],
    relative_track: Number(tileMatch[1].slice(1, 4)),
    orbit_number: Number(entry.orbit_calculated_spatial_domains?.[0]?.orbit_number) || null,
    orbit_direction: entry.orbit_direction
      ? String(entry.orbit_direction).trim().toUpperCase()
      : null,
    polarizations,
    assets,
    geometry,
    granule_size_mb: Number.isFinite(Number(entry.granule_size))
      ? Number(entry.granule_size)
      : null,
    source_url: `${CMR_BASE}/granules.json?${new URLSearchParams({ concept_id: id })}`,
    collection: COLLECTION,
    processing_level: "RTC-S1 v1",
    coordinate_system: entry.coordinate_system ?? null,
  };
}

export function normalizeScene(scene) {
  const productId = String(scene.product_id ?? "");
  const modeMatch = /(?:^|_)(IW|EW|SM|WV)([1-3])(?=_|$)/.exec(
    String(scene.mode ?? productId),
  );
  const versionMatch = /_v([\d.]+)$/.exec(productId);
  return {
    ...scene,
    acquisition_mode: scene.acquisition_mode ?? modeMatch?.[1] ?? null,
    subswath: scene.subswath ?? (modeMatch?.[2] ? Number(modeMatch[2]) : null),
    processing_version: scene.processing_version ?? versionMatch?.[1] ?? null,
  };
}

export function compatiblePair(a, b) {
  return a.id !== b.id
    && a.acquired_at.slice(0, 10) !== b.acquired_at.slice(0, 10)
    && a.tile === b.tile
    && a.mode === b.mode
    && Boolean(a.acquisition_mode && b.acquisition_mode)
    && a.acquisition_mode === b.acquisition_mode
    && Number.isInteger(a.subswath)
    && Number.isInteger(b.subswath)
    && a.subswath === b.subswath
    && (!a.processing_version || !b.processing_version || a.processing_version === b.processing_version)
    && (!a.orbit_direction || !b.orbit_direction || a.orbit_direction === b.orbit_direction)
    && a.polarizations.some((polarization) => b.polarizations.includes(polarization));
}

export function findDefaultPair(items) {
  const ordered = [...items].sort((a, b) => a.acquired_at.localeCompare(b.acquired_at));
  const seenByTileMode = new Map();
  let latestSamePlatformPair = [];
  let latestCrossPlatformPair = [];

  for (const scene of ordered) {
    const key = [
      scene.tile,
      scene.mode,
      scene.acquisition_mode,
      scene.subswath,
    ].join("|");
    const candidates = seenByTileMode.get(key) ?? [];
    for (const candidate of candidates) {
      if (!compatiblePair(candidate, scene)) continue;
      if (candidate.platform === scene.platform) {
        latestSamePlatformPair = [candidate, scene];
      } else {
        latestCrossPlatformPair = [candidate, scene];
      }
    }
    candidates.push(scene);
    seenByTileMode.set(key, candidates);
  }
  return latestSamePlatformPair.length
    ? latestSamePlatformPair
    : latestCrossPlatformPair;
}
