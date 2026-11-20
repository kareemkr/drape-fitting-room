import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createLiveWaistTracker, deriveLiveWaist, estimatePhotoWaist } from "../lib/fitting/live-waist.js";

const frame = { width: 640, height: 960 };
const models = await Promise.all(["male", "female"].map(async (name) =>
  JSON.parse(await readFile(new URL(`../app/studio-models/${name}-landmarks.json`, import.meta.url), "utf8")),
));
const move = (points, change, ids) => points.map((p, i) =>
  ids && !ids.includes(i) ? p : { ...p, ...change(p, i) },
);
function near(a, b) {
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

test("moving only the arms or hands leaves both torso fit anchors exactly fixed on both studio models", () => {
  for (const points of models) {
    const fit = deriveLiveWaist(points, frame);
    assert.ok(fit);
    const tracker = createLiveWaistTracker();
    for (let i = 0; i <= 20; i++) {
      const handsAcrossBelt = move(points, (p, id) => ({
        x: 0.2 + (0.6 * i) / 20, y: 0.4 + 0.08 * Math.sin(i + id / 4),
      }), [13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
      assert.deepEqual(tracker.update(handsAcrossBelt, frame, 90 * i), fit);
    }
  }
});

test("each side uses its own hip and shoulder across body widths, shear, mirroring, and nonzero photo origin", () => {
  const picture = { ...frame, left: 41, top: -18 };
  for (const points of models) {
    const center = (points[23].x + points[24].x) / 2;
    for (const hipScale of [0.68, 1, 1.76]) {
      const wider = move(points, (p, i) => ({ x: center + (p.x - center) * hipScale + 0.045, y: p.y + (i === 23 ? -0.012 : 0.024) }), [23, 24]);
      for (const transformed of [wider, move(wider, (p) => ({ x: 1 - p.x }))]) {
        const fit = deriveLiveWaist(transformed, picture);
        assert.ok(fit);
        assert.ok(fit.waist[0].x < fit.waist[1].x);
        for (const [side, id] of fit.ids.entries()) {
          const a = transformed[id], b = transformed[id + 12];
          near(fit.waist[side], {
            x: picture.left + (a.x + (b.x - a.x) * 0.70) * frame.width,
            y: picture.top + (a.y + (b.y - a.y) * 0.70) * frame.height,
          });
        }
      }
    }
  }
});

test("an isolated hip jump onto a hand is held while the opposite hip remains visible", () => {
  for (const points of models) {
    const tracker = createLiveWaistTracker();
    const fit = tracker.update(points, frame, 0);
    const displaced = move(points, (p) => ({ x: p.x - 0.10, y: p.y - 0.055, confidence: 0.96 }), [23]);
    displaced[15] = { ...displaced[23] };
    const side = fit.ids.indexOf(11);
    const outlier = tracker.update(displaced, frame, 90);
    assert.ok(outlier.carried[side]);
    assert.equal(outlier.carried[1 - side], false);
    near(outlier.waist[side], fit.waist[side]);
    assert.deepEqual(tracker.update(points, frame, 180), fit);
  }
});

test("one weak hip follows the measured torso through camera translation, zoom, and roll with no extra frame of lag", () => {
  for (const points of models) {
    const tracker = createLiveWaistTracker();
    tracker.update(points, frame, 0);
    const focal = { x: frame.width / 2, y: frame.height / 2 };
    const angle = -0.08, scale = 0.92;
    const rotated = move(points, (p) => {
      const x = p.x * frame.width - focal.x, y = p.y * frame.height - focal.y;
      return {
        x: (focal.x + 18 + scale * (x * Math.cos(angle) - y * Math.sin(angle))) / frame.width,
        y: (focal.y - 12 + scale * (x * Math.sin(angle) + y * Math.cos(angle))) / frame.height,
      };
    });
    const leaned = move(rotated, (p) => ({ x: p.x + 0.018, y: p.y + 0.005 }), [23, 24]);
    const expected = deriveLiveWaist(leaned, frame);
    const obscured = move(leaned, () => ({ confidence: 0.05, x: 0, y: 0 }), [24]);
    assert.equal(deriveLiveWaist(obscured, frame), null);
    const fit = tracker.update(obscured, frame, 100);
    assert.deepEqual(fit.carried, expected.ids.map((id) => id === 12));
    fit.waist.forEach((p, side) => near(p, expected.waist[side]));
    near(fit.waistCenter, expected.waistCenter);
  }
});

test("genuine coherent hip movement follows immediately, with a bounded hold for missing hips and immediate reacquisition", () => {
  for (const points of models) {
    const tracker = createLiveWaistTracker();
    tracker.update(points, frame, 0);
    const leaning = move(points, (p) => ({ x: p.x + 0.09, y: p.y - 0.035 }), [23, 24]);
    const fit = tracker.update(leaning, frame, 100);
    assert.deepEqual(fit, deriveLiveWaist(leaning, frame));
    const hidden = move(leaning, () => ({ confidence: 0 }), [23, 24]);
    const carried = tracker.update(hidden, frame, 280);
    assert.deepEqual(carried.carried, [true, true]);
    assert.deepEqual(carried.waist, fit.waist);
    assert.equal(tracker.update(hidden, frame, 560), null);
    assert.deepEqual(tracker.update(leaning, frame, 620), fit);
    tracker.reset();
    assert.equal(tracker.update(hidden, frame, 640), null);
  }
});

test("a camera resize, lost person, or time discontinuity cannot carry the previous subject's hip calibration", () => {
  const points = models[0];
  const hidden = move(points, () => ({ confidence: 0 }), [23, 24]);
  for (const invalidate of [
    (tracker) => tracker.update(null, frame, 100),
    (tracker) => tracker.update(hidden, { width: 480, height: 640 }, 100),
    (tracker) => tracker.update(hidden, frame, 1300),
    (tracker) => tracker.update(hidden, frame, -1),
    (tracker) => tracker.update(move(points, () => ({ confidence: NaN }), [11]), frame, 100),
  ]) {
    const tracker = createLiveWaistTracker();
    assert.ok(tracker.update(points, frame, 0));
    assert.equal(invalidate(tracker), null);
    assert.equal(tracker.update(hidden, frame, 1500), null);
  }
});

test("an abrupt symmetric spread does not move the seams when the estimated pelvis doubles in width", () => {
  for (const points of models) {
    const tracker = createLiveWaistTracker();
    const fit = tracker.update(points, frame, 0);
    const wrong = move(points, (p, id) => ({ x: p.x + (id === 23 ? 0.10 : -0.10) }), [23, 24]);
    for (const time of [90, 180, 270, 360]) {
      const held = tracker.update(wrong, frame, time);
      assert.deepEqual(held.carried, [true, true]);
      assert.deepEqual(held.waist, fit.waist);
    }
    assert.equal(tracker.update(wrong, frame, 450), null);
    assert.deepEqual(tracker.update(points, frame, 540), fit);
  }
});

test("a sustained plausible pelvis rotation is reacquired from three independent readings", () => {
  for (const points of models) {
    const tracker = createLiveWaistTracker();
    tracker.update(points, frame, 0);
    // Pivot around the far hip at a fixed projected pelvic length.
    const radiusX = (points[23].x - points[24].x) * frame.width;
    const radiusY = (points[23].y - points[24].y) * frame.height;
    const angle = 0.54;
    const turned = move(points, () => ({
      x: points[24].x + (radiusX * Math.cos(angle) - radiusY * Math.sin(angle)) / frame.width,
      y: points[24].y + (radiusX * Math.sin(angle) + radiusY * Math.cos(angle)) / frame.height,
    }), [23]);
    assert.ok(tracker.update(turned, frame, 90).carried.includes(true));
    assert.ok(tracker.update(turned, frame, 90).carried.includes(true));
    assert.ok(tracker.update(turned, frame, 180).carried.includes(true));
    assert.deepEqual(tracker.update(turned, frame, 270), deriveLiveWaist(turned, frame));
  }
});

test("preview animation and shutter use the same protected mesh while animation contributes no new measurements", async () => {
  const { createLiveGarmentRenderer } = await import("../lib/fitting/garment-renderer.js");
  const { mapTop } = await import("../lib/fitting/live-top.js");
  const rows = Array.from({ length: 49 }, () => ({ left: 0.2, right: 0.8, runs: [[0.2, 0.8]] }));
  const product = { category: "top", texture: { width: 350, height: 420 },
    topProfile: mapTop({ category: "top", description: "Sleeveless vest", aspect: 350 / 420, rows }) };
  const canvas = { ...frame };
  const context = { canvas };
  for (const name of ["setTransform", "clearRect", "save", "beginPath", "moveTo", "lineTo", "closePath", "clip", "transform", "drawImage", "restore"]) context[name] = () => {};
  canvas.getContext = () => context;
  const renderer = createLiveGarmentRenderer(canvas);
  const points = models[0];
  const bad = move(points, (p) => ({ x: p.x - 0.10, y: p.y - 0.055 }), [23]);
  const midway = move(points, (p, i) => ({ x: (p.x + bad[i].x) / 2, y: (p.y + bad[i].y) / 2 }));
  const initial = renderer.measurePose(points, 0);
  assert.ok(renderer.draw(product, points, { exact: true, waistProfile: initial }));
  const baseline = renderer.getAnchors();
  function sameAnchors() {
    for (const ring of ["waist", "hem"]) renderer.getAnchors()[ring].forEach((p, i) => near(p, baseline[ring][i]));
  }
  const fixed = renderer.measurePose(bad, 90);
  assert.ok(fixed.carried.includes(true));
  for (let i = 0; i < 12; i++) {
    assert.ok(renderer.draw(product, midway, { measured: true }));
    sameAnchors();
  }
  assert.ok(renderer.draw(product, bad, { exact: true, waistProfile: fixed }));
  sameAnchors();
  renderer.clear({ keepPose: true });
  assert.ok(renderer.draw(product, bad, { measured: true }));
  sameAnchors();
  renderer.measurePose(points, 180);
  assert.ok(renderer.draw(product, midway, { measured: true }));
  sameAnchors();
  renderer.measurePose(null, 270);
  assert.equal(renderer.draw(product, midway, { measured: true }), false);
  assert.equal(renderer.getAnchors(), null);
  assert.equal(renderer.draw(product, points, { exact: true, waistProfile: null }), false);
  assert.ok(renderer.draw(product, points, { exact: true }));
  renderer.clear();
  assert.equal(renderer.draw(product, points, { measured: true }), false);
  assert.ok(renderer.draw(product, points, { timestamp: 360 }));
  renderer.dispose();
  assert.equal(renderer.measurePose(points, 450), null);
});


test("cropped stills explicitly report a shoulder estimate while the camera awaits measured hips", () => {
  for (const points of models) {
    assert.equal(estimatePhotoWaist(points, frame), null);
    for (const hidden of [[23], [23, 24]]) {
      const cropped = move(points, () => ({ y: 1.25, confidence: 0.07 }), hidden);
      const fit = estimatePhotoWaist(cropped, frame);
      assert.equal(fit.source, "shoulder-estimate");
      assert.equal(fit.estimated, true);
      assert.deepEqual(fit, estimatePhotoWaist(move(cropped, () => ({ x: 0.01, y: 0.99 }), [13, 14, 15, 16]), frame));
      assert.equal(deriveLiveWaist(cropped, frame), null);
      assert.equal(createLiveWaistTracker().update(cropped, frame, 0), null);
      assert.equal(estimatePhotoWaist(move(cropped, () => ({ confidence: 0.52 }), [11]), frame), null);
      const sideways = move(cropped, (p, id) => ({ z: id === 11 ? -0.45 : 0.45 }), [11, 12]);
      assert.equal(estimatePhotoWaist(sideways, frame), null);
    }
    const invertedHips = move(points, () => ({ y: 0.05 }), [23, 24]);
    assert.equal(deriveLiveWaist(invertedHips, frame), null);
    assert.equal(estimatePhotoWaist(invertedHips, frame), null);
  }
});
