import test from "node:test";
import assert from "node:assert/strict";
import { createLiveOutline } from "../lib/fitting/live-outline.js";

function fixture(crossed = false, handOnHip = false) {
  const width = 260,
    height = 280;
  const pos = {
    11: [160, 78],
    12: [100, 78],
    13: [170, 121],
    14: handOnHip ? [65, 117] : [84, 117],
    15: crossed ? [118, 144] : [176, 166],
    16: handOnHip ? [103, 152] : crossed ? [146, 144] : [79, 166],
    23: [151, 172],
    24: [109, 172],
  };
  const points = Array.from({ length: 33 }, (_, i) => ({
    x: (pos[i]?.[0] ?? 130) / width,
    y: (pos[i]?.[1] ?? 60) / height,
    confidence: 1,
  }));
  const pixels = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
  const tube = (x, y, a, b, r) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      t = Math.max(
        0,
        Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)),
      );
    return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t) < r;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const fg =
        ((x - 130) / 39) ** 2 + ((y - 127) / 61) ** 2 <= 1 ||
        [
          [11, 13, 10],
          [12, 14, 10],
          [13, 15, 7],
          [14, 16, 7],
        ].some(([a, b, r]) => tube(x, y, pos[a], pos[b], r));
      pixels.data.set(
        fg ? [55, 50, 54, 255] : [180, 180, 180, 255],
        (y * width + x) * 4,
      );
    }
  return { points, pixels };
}
function clutter(pixels) {
  let state = 512;
  for (let i = 0; i < pixels.data.length; i += 4) {
    state = (1664525 * state + 1013904223) >>> 0;
    const color = state % 5;
    pixels.data.set(
      [
        [25, 33, 97, 255],
        [229, 184, 26, 255],
        [119, 72, 192, 255],
        [58, 170, 68, 255],
        [189, 111, 104, 255],
      ][color],
      i,
    );
  }
}

test("plain background calibrates only shoulders and sleeves; input landmarks are immutable", () => {
  const { points, pixels } = fixture(),
    snapshot = structuredClone(points);
  const calibrated = createLiveOutline().sample(points, pixels, 100);
  assert.deepEqual(points, snapshot);
  assert.equal(points.outline, undefined);
  assert.ok(calibrated.outline);
  assert.deepEqual(calibrated.slice(), points);
  for (const side of [calibrated.outline.left, calibrated.outline.right]) {
    assert.ok(side.shoulderArc?.length >= 4);
    assert.ok(side.upperArm > 0);
    for (const key of ["chest", "waist", "hem"])
      assert.equal(side[key], undefined);
  }
});

test("stationary frames reuse the calibration; a pose change triggers a throttled update", () => {
  const { points, pixels } = fixture(),
    tracker = createLiveOutline();
  const first = tracker.sample(points, pixels, 0).outline;
  assert.ok(first);
  assert.equal(tracker.sample(points, pixels, 600).outline, first);
  const changed = fixture(true);
  pixels.data.set(changed.pixels.data);
  const crossed = tracker.sample(changed.points, pixels, 625).outline;
  assert.ok(crossed);
  assert.notEqual(crossed, first);
  for (const side of [crossed.left, crossed.right]) {
    assert.equal(side.wrist, undefined);
    assert.equal(side.waist, undefined);
    assert.equal(side.chest, undefined);
  }
  assert.equal(tracker.sample(changed.points, pixels, 650).outline, crossed);
});

test("clutter, loss, replacement camera and unreadable frames fall back to the joint rig", () => {
  const { points, pixels } = fixture(),
    tracker = createLiveOutline();
  const first = tracker.sample(points, pixels, 0);
  assert.ok(first.outline);
  clutter(pixels);
  assert.equal(tracker.sample(points, pixels, 100).outline, first.outline);
  assert.equal(tracker.sample(points, pixels, 1500), points);
  assert.equal(tracker.sample(first, pixels, 1520).outline, undefined);
  const empty = Array(33).fill(null);
  assert.equal(tracker.sample(empty, pixels, 1530), empty);
  const fresh = fixture();
  assert.ok(tracker.sample(fresh.points, fresh.pixels, 1550).outline);
  tracker.reset();
  assert.equal(tracker.sample(points, {}, 1590), points);
});

test("a bent arm against a plain wall exposes only its measured outside radius", () => {
  const { points, pixels } = fixture(false, true);
  const side = createLiveOutline().sample(points, pixels, 0).outline.left;
  assert.equal(side.forearm, undefined);
  assert.ok(Math.abs(side.outerForearm * 60 - 7) < 1.5);
  assert.equal(side.waist, undefined);
});
