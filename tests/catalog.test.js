import assert from "node:assert/strict";
import test from "node:test";

import { compatiblePair, findDefaultPair } from "../src/catalog.js";

function scene(id, date, platform, tile = "T009-017868-IW1") {
  return {
    id,
    acquired_at: `${date}T07:30:00.000Z`,
    platform,
    tile,
    mode: "IW1",
    acquisition_mode: "IW",
    subswath: 1,
    processing_version: "1.0",
    orbit_direction: "ASCENDING",
    polarizations: ["VV", "VH"],
  };
}

test("automatic pairing prefers the newest compatible same-platform pair", () => {
  const expected = [
    scene("same-old", "2026-09-01", "S1A"),
    scene("same-new", "2026-09-13", "S1A"),
  ];
  const pair = findDefaultPair([
    scene("cross-old", "2026-01-01", "S1A"),
    scene("cross-mid", "2026-01-13", "S1C"),
    ...expected,
    scene("latest-same-platform", "2026-11-01", "S1A"),
    scene("newer-cross-platform", "2026-11-20", "S1B"),
  ]);

  assert.deepEqual(pair.map((item) => item.id), [
    "same-new",
    "latest-same-platform",
  ]);
});

test("automatic pairing uses a cross-platform match only when necessary", () => {
  const before = scene("before", "2026-10-01", "S1A");
  const after = scene("after", "2026-10-13", "S1C");
  assert.deepEqual(findDefaultPair([after, before]).map((item) => item.id), [
    "before",
    "after",
  ]);
});

test("automatic pairing rejects same-day or different-tile products", () => {
  const before = scene("before", "2026-10-01", "S1A");
  const sameDay = scene("same-day", "2026-10-01", "S1A");
  const otherTile = scene("other-tile", "2026-10-13", "S1A", "T010-017868-IW1");

  assert.equal(compatiblePair(before, sameDay), false);
  assert.equal(compatiblePair(before, otherTile), false);
  assert.deepEqual(findDefaultPair([before, sameDay, otherTile]), []);
});
