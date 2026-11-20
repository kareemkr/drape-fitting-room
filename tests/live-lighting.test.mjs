import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveLighting,
  estimateLightDirection,
} from "../lib/fitting/live-lighting.js";

function fixture(colorAt) {
  const width = 101,
    height = 80;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([...colorAt(x - 50, y), 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const sampleAt = (u, v) => ({
  x: Math.round(u * 100 + 50),
  y: Math.round(v * 79),
});
const gray = (n) => [n, n, n];

test("scene light follows a consistent broad illumination gradient in either direction", () => {
  const ramp = (sign) => fixture((x) => gray(128 + sign * x));
  const fromRight = estimateLightDirection(ramp(1), sampleAt);
  const fromLeft = estimateLightDirection(ramp(-1), sampleAt);
  assert.ok(fromRight > 0.45);
  assert.ok(Math.abs(fromLeft + fromRight) < 0.001);
});

test("a flat shirt, a contrasting center print, or differently colored panels do not set a directional light", () => {
  const materials = [
    fixture(() => [98, 48, 53]),
    fixture((x) => gray(Math.abs(x) < 8 ? 18 : 184)),
    fixture((x) => (x < 0 ? [168, 101, 82] : [53, 128, 181])),
    fixture((x, y) =>
      gray((y % 8 < 4 ? 90 : 150) + (Math.abs(x) % 7 < 3 ? 12 : 0)),
    ),
  ];
  for (const image of materials)
    assert.equal(estimateLightDirection(image, sampleAt), 0);
});

test("a single logo row leaves the robust light estimate intact", () => {
  const gradient = fixture((x) => gray(128 + x));
  const occluded = fixture((x, y) =>
    y > 23 && y < 32 ? [180, 12, 10] : gray(128 + x),
  );
  assert.ok(
    Math.abs(
      estimateLightDirection(gradient, sampleAt) -
        estimateLightDirection(occluded, sampleAt),
    ) < 0.06,
  );
});

test("missing or crossed-arm samples fall back to neutral", () => {
  const image = fixture((x) => gray(128 + x));
  assert.equal(
    estimateLightDirection(image, () => null),
    0,
  );
  assert.equal(
    estimateLightDirection(image, () => ({ x: -5, y: 10 })),
    0,
  );
  assert.equal(
    estimateLightDirection(image, (u, v) => (u > 0 ? null : sampleAt(u, v))),
    0,
  );
});

test("a missing source or missing torso leaves the existing renderer untouched", () => {
  const lighting = createLiveLighting();
  const ctx = { canvas: { width: 480, height: 640 } };
  lighting.apply(ctx, { category: "top" }, [], null);
  lighting.apply(ctx, { category: "top" }, [], {});
  lighting.apply(ctx, { category: "bottom" }, [], {});
  lighting.reset();
});

// Exercise the actual alpha tile and compositing call without a browser GPU.
test("torso light stays anchored when the hand moves, with one camera read across adjacent draws", (t) => {
  const source = { width: 200, height: 300 };
  const pose = Array(33).fill(null);
  const point = (x, y) => ({ x, y, confidence: 1 });
  pose[11] = point(0.29, 0.23);
  pose[12] = point(0.71, 0.23);
  pose[23] = point(0.34, 0.6);
  pose[24] = point(0.66, 0.6);
  pose[13] = point(0.19, 0.42);
  pose[15] = point(0.19, 0.66);
  const product = { category: "top" };
  let reads = 0,
    now = 100;
  t.mock.method(performance, "now", () => now);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, "document", previous)
      : delete globalThis.document,
  );
  globalThis.document = {
    createElement() {
      const canvas = {};
      canvas.getContext = () => ({
        canvas,
        clearRect() {},
        drawImage() {},
        getImageData() {
          reads++;
          return fixture(() => gray(128));
        },
        createImageData(w, h) {
          return {
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          };
        },
        putImageData(image) {
          canvas.image = image;
        },
      });
      return canvas;
    },
  };
  const calls = [];
  const ctx = {
    canvas: source,
    save() {},
    restore() {},
    transform(...args) {
      calls.push(args);
    },
    drawImage(tile) {
      calls.push([this.globalCompositeOperation, tile]);
    },
  };
  const lighting = createLiveLighting();
  lighting.apply(ctx, product, pose, source);
  const initial = calls.splice(0);
  assert.equal(initial[1][0], "source-atop");
  const tile = initial[1][1].image;
  const center =
    tile.data[((tile.height >> 1) * tile.width + (tile.width >> 1)) * 4 + 3];
  const side =
    tile.data[
      ((tile.height >> 1) * tile.width + Math.round(tile.width * 0.16)) * 4 + 3
    ];
  assert.ok(side > center + 12);
  for (let i = 0; i < tile.data.length; i += 4) {
    assert.equal(tile.data[i] + tile.data[i + 1] + tile.data[i + 2], 0);
    assert.ok(tile.data[i + 3] <= Math.ceil(0.23 * 255));
  }
  pose[15] = point(0.5, 0.57);
  now += 18;
  lighting.apply(ctx, product, pose, source);
  assert.deepEqual(calls, initial);
  assert.equal(reads, 1);
  now += 251;
  lighting.apply(ctx, product, pose, source);
  assert.equal(reads, 2);
  lighting.reset();
  lighting.apply(ctx, product, pose, source);
  assert.equal(reads, 3);
});
