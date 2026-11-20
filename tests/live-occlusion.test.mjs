import assert from "node:assert/strict";
import test from "node:test";
import { foregroundHandMasks } from "../lib/fitting/live-occlusion.js";

const frame = { width: 200, height: 200 };
const oxford = { category: "top", sleeveLength: "long" };
const polo = { category: "top", sleeveLength: "short" };
const navy = [45, 50, 92];

function pose() {
  const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, confidence: 0 }));
  const entries = {
    0: [100, 47], 2: [94, 41], 5: [106, 41],
    11: [145, 75], 12: [55, 75], 23: [138, 153], 24: [62, 153],
    14: [48, 137], 16: [85, 137], 18: [102, 142], 20: [105, 131], 22: [99, 127],
  };
  for (const [index, [x, y]] of Object.entries(entries)) {
    pts[index] = { x: x / frame.width, y: y / frame.height, z: 0, confidence: 1 };
  }
  return pts;
}

// Rebuild small synthetic RGBA regions only. The wrist sits on the waist,
// with a slim band of original shirt visible between two fingers.
function reader(skin, { hasHand = true, shirt = navy, shaded = false, skinColoredPrint = false } = {}) {
  return (rect, longest) => {
    const scale = Math.min(1, longest / Math.max(rect.width, rect.height));
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = rect.x + (x + 0.5) / scale, sy = rect.y + (y + 0.5) / scale;
        const isFace = sx >= 80 && sx <= 120 && sy >= 28 && sy <= 59;
        const upper = sy >= 132 && sy <= 136 && sx > 103 && sx < 120;
        const lower = sy >= 139 && sy <= 143 && sx > 103 && sx < 120;
        const palm = sx >= 81 && sx <= 104 && sy >= 130 && sy < 146;
        const arm = sx >= 47 && sx < 82 && sy >= 132 && sy < 143;
        const isHand = hasHand && (palm || upper || lower || arm);
        const print = skinColoredPrint && sx >= 106 && sx <= 114 && sy >= 123 && sy <= 126;
        const rgb = isFace || isHand || print ? skin : shirt;
        const light = isHand && shaded ? 0.80 + ((sx + sy) % 11) / 100 : 1;
        const i = 4 * (y * width + x);
        for (let c = 0; c < 3; c++) data[i + c] = Math.round(rgb[c] * light);
        data[i + 3] = 255;
      }
    }
    return { width, height, data };
  };
}

function at(masks, x, y) {
  for (const { rect, width, height, alpha } of masks) {
    const px = Math.floor((x - rect.x) * width / rect.width);
    const py = Math.floor((y - rect.y) * height / rect.height);
    if (px >= 0 && py >= 0 && px < width && py < height) return alpha[py * width + px];
  }
  return 0;
}

for (const [name, skin] of Object.entries({ light: [238, 189, 160], medium: [164, 109, 80], deep: [77, 49, 40] })) {
  test(`preserves ${name} skin in local shadow and keeps cloth in the finger gap`, () => {
    const masks = foregroundHandMasks(oxford, pose(), frame, reader(skin, { shaded: true }));
    assert.equal(at(masks, 90, 136), 255);
    assert.equal(at(masks, 114, 133), 255);
    assert.equal(at(masks, 114, 140), 255);
    assert.equal(at(masks, 114, 137), 0);
    assert.equal(at(masks, 92, 149), 0);
  });
}

test("keeps a long sleeve on the forearm but the same exposed short-sleeve arm crosses in front", () => {
  const pixels = reader([164, 109, 80]);
  assert.equal(at(foregroundHandMasks(oxford, pose(), frame, pixels), 68, 137), 0);
  assert.equal(at(foregroundHandMasks(polo, pose(), frame, pixels), 68, 137), 255);
});

test("wrist behind the local torso makes no hole, with no pixel read", () => {
  const points = pose();
  points[16].z = 0.32;
  assert.deepEqual(foregroundHandMasks(polo, points, frame, () => assert.fail("unnecessary read")), []);
});

test("2D landmarks with no fingers can expose a witnessed palm", () => {
  const points = pose();
  for (const point of points) delete point.z;
  for (const index of [18, 20, 22]) points[index].confidence = 0;
  const masks = foregroundHandMasks(oxford, points, frame, reader([164, 109, 80]));
  assert.equal(at(masks, 96, 135), 255);
  assert.equal(at(masks, 100, 149), 0);
});

test("matching shirt color with no visible hand leaves the whole shirt intact", () => {
  const color = [166, 115, 87];
  assert.deepEqual(foregroundHandMasks(polo, pose(), frame, reader(color, { shirt: color, hasHand: false })), []);
  assert.deepEqual(foregroundHandMasks(polo, pose(), frame, reader(color, { hasHand: false })), []);
});

test("unreadable frames and low-confidence wrists or missing face do not leave stale hand shapes", () => {
  const points = pose();
  assert.deepEqual(foregroundHandMasks(oxford, points, frame, () => null), []);
  points[16].confidence = 0.27;
  assert.deepEqual(foregroundHandMasks(oxford, points, frame, () => assert.fail("unnecessary read")), []);
  points[16].confidence = 1;
  points[0].confidence = 0.21;
  assert.deepEqual(foregroundHandMasks(oxford, points, frame, reader([77, 49, 40])), []);
});

function cpuPose() {
  const points = pose();
  for (const i of [18, 20, 22]) points[i].confidence = 0;
  points[16].confidence = 0.505;
  points[0].confidence = 0.548;
  points[2].confidence = 0.453;
  points[5].confidence = 0.398;
  return points;
}

test("measured MoveNet scores support a witnessed hand in full and cropped upper-body views", () => {
  const points = cpuPose();
  const pixels = reader([164, 109, 80]);
  for (const cropHips of [false, true]) {
    if (cropHips) for (const i of [23, 24]) points[i].confidence = 0;
    const masks = foregroundHandMasks(oxford, points, frame, pixels, "movenet");
    assert.equal(at(masks, 95, 137), 255);
    assert.equal(at(masks, 114, 137), 0);
  }
});

test("MoveNet calibration requires an explicit backend and leaves absent hands covered", () => {
  const points = cpuPose();
  const color = [166, 115, 87];
  for (const backend of [undefined, "mediapipe", "mediapipe-cpu"]) {
    assert.deepEqual(foregroundHandMasks(oxford, points, frame, reader(color), backend), []);
  }
  assert.deepEqual(foregroundHandMasks(oxford, points, frame, reader(color, { hasHand: false }), "movenet"), []);
  assert.deepEqual(foregroundHandMasks(oxford, points, frame, reader(color, { shirt: color, hasHand: false }), "movenet"), []);
  points[16].confidence = 0.29;
  assert.deepEqual(foregroundHandMasks(oxford, points, frame, () => assert.fail("unnecessary read"), "movenet"), []);
});

test("a bent wrist at the side waist finds inward fingers and keeps an isolated fabric print", () => {
  const points = cpuPose();
  points[16] = { x: 74 / 200, y: 137 / 200, z: 0, confidence: 0.64 };
  points[14] = { x: 38 / 200, y: 91 / 200, z: 0, confidence: 0.76 };
  const masks = foregroundHandMasks(oxford, points, frame,
    reader([164, 109, 80], { skinColoredPrint: true }), "movenet");
  assert.equal(at(masks, 114, 133), 255);
  assert.equal(at(masks, 114, 137), 0);
  assert.equal(at(masks, 110, 124), 0);
});
