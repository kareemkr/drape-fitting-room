import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { getGarmentAnatomy } from "../lib/fitting/garment-anatomy.js";
import { getGarmentSize, NEUTRAL_SIZE_GRADE } from "../lib/fitting/garment-size.js";
import { buildFullBodyMesh } from "../lib/fitting/live-fullbody.js";
import { buildTopMesh, mapTop } from "../lib/fitting/live-top.js";

const frame = { height: 720, width: 480, left: 0, top: 0 };
const poses = JSON.parse(await readFile(new URL("./fixtures/waist-contact/poses.json", import.meta.url)));
const pose = poses[0].landmarks.map(([x, y, z, confidence]) => ({ x, y, z, confidence }));

function pattern(category, description) {
  const trousers = description.includes("trousers");
  const rows = Array.from({ length: 65 }, (_, i) => {
    const y = i / 64;
    let runs = [[.13, .87]];
    if (category === "top" && y > .55) runs = [[.04, .15], [.21, .79], [.85, .96]];
    if (trousers && y > .33) runs = [[.05, .45], [.55, .95]];
    return {
      runs, left: runs[0][0], right: runs.at(-1)[1],
      gap: trousers && y > .33 ? { left: .45, right: .55 } : null,
      split: trousers && y > .33 ? .5 : null,
    };
  });
  return { category, description, rows, trunkRows: rows, aspect: .72,
    separatesLegs: trousers, waistY: category === "dress" ? .34 : 0, fork: trousers ? .33 : 1 };
}

const top = mapTop(pattern("top", "long sleeved Oxford"), getGarmentAnatomy(null, null, { id: "shirt" }));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + " vs " + b);
const span = (mesh) => distance(mesh.rings.waist[0], mesh.rings.waist[2]);

test("each successive size grades the shirt around the same center waist and collar", () => {
  const reference = buildTopMesh(pose, frame, top);
  assert.deepEqual(reference, buildTopMesh(pose, frame, top, undefined, {}, NEUTRAL_SIZE_GRADE));
  const center = (m) => m.vertices[m.panels.find((p) => p.region === "torso").firstVertex + 6].t;
  let lastWidth = 0, lastDrop = 0;
  for (let step = -3; step <= 3; step++) {
    const grade = getGarmentSize({ category: "top" }, step).factors;
    const mesh = buildTopMesh(pose, frame, top, undefined, {}, grade);
    assert.deepEqual(center(mesh), center(reference));
    assert.deepEqual(mesh.rings.waist[1], reference.rings.waist[1]);
    const drop = distance(center(mesh), mesh.rings.hem[1]);
    assert.ok(span(mesh) > lastWidth && drop > lastDrop);
    lastWidth = span(mesh); lastDrop = drop;
  }
});

test("grading sleeve circumference changes only sleeve geometry even with a wrist across the body", () => {
  for (const item of poses) {
    const points = item.landmarks.map(([x, y, z, confidence]) => ({ x, y, z, confidence }));
    const base = buildTopMesh(points, frame, top);
    const wide = buildTopMesh(points, frame, top, undefined, {}, { ...NEUTRAL_SIZE_GRADE, sleeveWidth: 1.16 });
    assert.deepEqual(wide.rings, base.rings);
    for (const panel of base.panels) {
      const vertices = (m) => m.vertices.slice(panel.firstVertex, panel.firstVertex + panel.vertexCount);
      if (panel.region === "torso") assert.deepEqual(vertices(base), vertices(wide));
      else {
        const a = vertices(base).slice(-3), b = vertices(wide).slice(-3);
        close(distance(b[0].t, b[2].t) / distance(a[0].t, a[2].t), 1.16);
      }
    }
  }
});

test("manual shirt fitting composes with a measured waist grade", () => {
  const options = { torsoScale: .85, scale: 1.2, sleeveScale: .9 };
  const base = buildTopMesh(pose, frame, top, undefined, options);
  const graded = buildTopMesh(pose, frame, top, undefined, options, { ...NEUTRAL_SIZE_GRADE, waist: 1.12 });
  close(span(graded) / span(base), 1.12);
});

for (const [category, name] of [["bottom", "maxi skirt"], ["bottom", "trousers"], ["dress", "midi dress"]]) {
  test(name + " grows from its fixed waist or neckline and retains the same neutral geometry", () => {
    const shape = pattern(category, name);
    const reference = buildFullBodyMesh(pose, frame, shape);
    assert.ok(reference);
    assert.deepEqual(reference.vertices, buildFullBodyMesh(pose, frame, shape, NEUTRAL_SIZE_GRADE).vertices);
    let lastWidth = 0, lastLength = 0;
    for (let i = -3; i <= 3; i++) {
      const mesh = buildFullBodyMesh(pose, frame, shape, getGarmentSize({ category }, i).factors);
      assert.deepEqual(mesh.pivot, reference.pivot);
      const row = mesh.vertices.filter((p) => p.s.y === 0);
      const band = distance(row[0].t, row.at(-1).t);
      const bottom = mesh.vertices.filter((p) => p.s.y === 1);
      const hemCenter = bottom.reduce((mean, v) => ({
        x: mean.x + v.t.x / bottom.length, y: mean.y + v.t.y / bottom.length,
      }), { x: 0, y: 0 });
      const length = distance(mesh.pivot, hemCenter);
      assert.ok(band > lastWidth && length > lastLength);
      lastWidth = band; lastLength = length;
    }
  });
}

test("lengthening a skirt beyond visible knees waits for the ankles", () => {
  const shape = pattern("bottom", "mini skirt");
  const missing = pose.map((p, i) => [27, 28].includes(i) ? { ...p, confidence: 0 } : p);
  assert.ok(buildFullBodyMesh(missing, frame, shape));
  assert.equal(buildFullBodyMesh(missing, frame, shape, { ...NEUTRAL_SIZE_GRADE, length: 1.65 }), null);
});
