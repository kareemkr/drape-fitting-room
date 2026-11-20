import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { getGarmentAnatomy } from "../lib/fitting/garment-anatomy.js";
import { readLiveSilhouette } from "../lib/fitting/live-fullbody.js";
import { foregroundHandMasks } from "../lib/fitting/live-occlusion.js";
import { buildTopMesh, mapTop } from "../lib/fitting/live-top.js";

const fixtureRoot = new URL("../tests/fixtures/waist-contact/", import.meta.url);
const cases = JSON.parse(await readFile(new URL("poses.json", fixtureRoot), "utf8"));

async function decode(url) {
  const { data, info } = await sharp(fileURLToPath(url)).toColourspace("srgb")
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  return { data, width: info.width, height: info.height };
}

// Coordinates index pixel centers. Clamp to the nearest edge pixel as Canvas
// does during image interpolation, including crops narrower than one pixel.
function bilinear(data, width, height, channels, x, y, channel = 0) {
  x = Math.max(0, Math.min(width - 1, x));
  y = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = data[(y0 * width + x0) * channels + channel];
  const b = data[(y0 * width + x1) * channels + channel];
  const c = data[(y1 * width + x0) * channels + channel];
  const d = data[(y1 * width + x1) * channels + channel];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function patchReader(source) {
  return (rect, limit) => {
    const scale = Math.min(1, limit / Math.max(rect.width, rect.height));
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const sy = rect.y + (y + 0.5) * rect.height / height - 0.5;
      for (let x = 0; x < width; x++) {
        const sx = rect.x + (x + 0.5) * rect.width / width - 0.5;
        for (let c = 0; c < 4; c++) {
          data[(y * width + x) * 4 + c] = bilinear(source.data, source.width, source.height, 4, sx, sy, c);
        }
      }
    }
    return { width, height, data };
  };
}

// Destination-out compositing multiplies the remaining opacity per hand. Map
// each marked source-pixel center back to the bounded, downsampled matte.
function handAlphaAt(masks, [x, y]) {
  let textile = 1;
  for (const { rect, width, height, alpha } of masks) {
    const u = (x + 0.5 - rect.x) / rect.width, v = (y + 0.5 - rect.y) / rect.height;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
    const opacity = bilinear(alpha, width, height, 1, u * width - 0.5, v * height - 0.5) / 255;
    textile *= 1 - opacity;
  }
  return Math.round(255 * (1 - textile));
}

const shirt = await decode(new URL("../public/studio/shirt.webp", import.meta.url));
const shape = readLiveSilhouette({ ...shirt, getContext: () => ({ getImageData: () => shirt }) }, "top", "Striped Oxford Shirt");
const profile = mapTop(shape, getGarmentAnatomy(null, null, { id: "shirt" }));
const product = { category: "top", sleeveLength: profile.sleeveLength };
assert.equal(product.sleeveLength, "long");

const failures = [];
let hands = 0, textiles = 0;
for (const item of cases) {
  const source = await decode(new URL(item.image, fixtureRoot));
  const frame = { width: source.width, height: source.height, left: 0, top: 0 };
  assert.deepEqual([frame.width, frame.height], [512, 768]);
  const points = item.landmarks.map(([x, y, z, confidence]) => ({ x, y, z, confidence }));
  assert.equal(points.length, 33);
  const masks = foregroundHandMasks(product, points, frame, patchReader(source));
  const handAlphas = item.handPixels.map((xy) => handAlphaAt(masks, xy));
  const textileAlphas = item.textilePixels.map((xy) => handAlphaAt(masks, xy));
  function check(label, values, positions, accept) {
    values.forEach((value, i) => {
      if (!accept(value)) failures.push(`${item.image}, ${label} (${positions[i]}) had hand alpha ${value}`);
    });
  }
  check("hand", handAlphas, item.handPixels, (a) => a >= 230);
  check("textile", textileAlphas, item.textilePixels, (a) => a <= 25);
  hands += handAlphas.length;
  textiles += textileAlphas.length;

  const original = buildTopMesh(points, frame, profile);
  assert.ok(original?.rings?.hem?.length === 3 && original.rings.waist?.length === 3, item.image);
  // Move both arms in opposite directions while preserving measured torso and
  // pelvis. The full shirt still follows the arms, while its six fit pins stay fixed.
  const swing = points.map((p, i) => i >= 13 && i <= 22 ? {
    ...p, x: i % 2 ? 0.16 : 0.84, y: i < 15 ? 0.31 : 0.26,
  } : p);
  const moved = buildTopMesh(swing, frame, profile);
  assert.deepEqual(moved?.rings, original.rings, `${item.image}: arm motion displaced the shirt waist or hem`);
  const sleeveMoved = original.panels.filter((panel) => panel.region === "sleeve").some((before) => {
    const after = moved.panels.find((p) => p.region === "sleeve" && p.side === before.side);
    if (!after || before.vertexCount !== after.vertexCount) return false;
    return original.vertices.slice(before.firstVertex, before.firstVertex + before.vertexCount).some((v, i) => {
      const current = moved.vertices[after.firstVertex + i].t;
      return Math.hypot(current.x - v.t.x, current.y - v.t.y) > 2;
    });
  });
  assert.ok(sleeveMoved, `${item.image}: arm perturbation did not move either sleeve`);
  console.log(`${item.image} — ${handAlphas.length} hand marks (min ${Math.min(...handAlphas)}), ${textileAlphas.length} textile marks (max ${Math.max(...textileAlphas)}), waist and hem fixed`);
}
assert.equal(cases.length, 4);
assert.equal(hands, 33);
assert.equal(textiles, 32);
assert.equal(failures.length, 0, failures.join("\n"));
console.log(`Passed ${hands + textiles} manually marked pixels and ${cases.length} garment anchor checks.`);
