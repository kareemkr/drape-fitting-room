import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapTop, buildTopMesh } from "../lib/fitting/live-top.js";
import { getGarmentAnatomy } from "../lib/fitting/garment-anatomy.js";

const standing = JSON.parse(
  await readFile(
    new URL("../app/studio-models/male-landmarks.json", import.meta.url),
  ),
);
const frame = { left: 23, top: 37, width: 520, height: 720 };
function shape(kind = "long", description = kind) {
  const rows = Array.from({ length: 65 }, (_, i) => {
    const y = i / 64;
    let runs;
    if (y < 0.14) runs = [[0.38 - y * 1.55, 0.62 + y * 1.55]];
    else if (kind === "sleeveless") runs = [[0.24, 0.76]];
    else if (kind === "short")
      runs = y < 0.44 ? [[0.04, 0.96]] : [[0.22, 0.78]];
    else
      runs =
        y < 0.6
          ? [[0.18 * (1 - y), 1 - 0.18 * (1 - y)]]
          : [
              [0.02, 0.17],
              [0.21, 0.79],
              [0.83, 0.98],
            ];
    return { runs, left: runs[0][0], right: runs.at(-1)[1] };
  });
  return { category: "top", description, aspect: 0.95, rows };
}
function withArm(pose, index, elbow, wrist) {
  const moved = structuredClone(pose);
  Object.assign(moved[index + 2], elbow);
  Object.assign(moved[index + 4], wrist);
  return moved;
}
function panel(mesh, region, side = null) {
  const part = mesh.panels.find((p) => p.region === region && p.side === side);
  assert.ok(part);
  return mesh.vertices.slice(
    part.firstVertex,
    part.firstVertex + part.vertexCount,
  );
}
const presets = [
  ...["shirt", "leather", "knit", "denim"].map((id) => [
    id,
    mapTop(shape(), getGarmentAnatomy(null, null, { id })),
  ]),
  ["uploaded tee", mapTop(shape("short", "short sleeve tee"), null)],
  ["uploaded vest", mapTop(shape("sleeveless", "tank vest"), null)],
  ["unlabelled uploaded long top", mapTop(shape(), null)],
];
for (const [name, profile] of presets) {
  test(
    name +
      " keeps every torso vertex fixed when a wrist crosses the waist or disappears",
    () => {
      const reference = buildTopMesh(standing, frame, profile);
      assert.ok(reference?.rings.waist && reference.rings.hem);
      const forearmAcross = withArm(
        standing,
        12,
        { x: 0.3, y: 0.34 },
        { x: 0.54, y: 0.46 },
      );
      const dropped = withArm(
        forearmAcross,
        12,
        { confidence: 0 },
        { confidence: 0 },
      );
      for (const pose of [forearmAcross, dropped]) {
        const candidate = buildTopMesh(pose, frame, profile);
        assert.deepEqual(candidate.rings, reference.rings);
        assert.deepEqual(panel(candidate, "torso"), panel(reference, "torso"));
        for (const part of candidate.panels) {
          const triangles = candidate.triangles.slice(
            part.firstTriangle,
            part.firstTriangle + part.triangleCount,
          );
          assert.ok(
            triangles.every((face) =>
              face.every(
                (i) =>
                  i >= part.firstVertex &&
                  i < part.firstVertex + part.vertexCount,
              ),
            ),
          );
        }
      }
      if (profile.sleeveLength === "sleeveless") {
        assert.equal(reference.panels.length, 1);
      } else {
        const candidate = buildTopMesh(forearmAcross, frame, profile);
        assert.notDeepEqual(
          panel(candidate, "sleeve", 0),
          panel(reference, "sleeve", 0),
        );
        assert.deepEqual(
          panel(candidate, "sleeve", 1),
          panel(reference, "sleeve", 1),
        );
      }
    },
  );
}
test("a short sleeve follows its upper arm without following the wrist", () => {
  const profile = presets[4][1],
    left = buildTopMesh(standing, frame, profile);
  assert.equal(profile.sleeveLength, "short");
  const walking = withArm(standing, 12, {}, { x: 0.49, y: 0.47 });
  const right = buildTopMesh(walking, frame, profile);
  assert.deepEqual(panel(left, "sleeve", 0), panel(right, "sleeve", 0));
});
test("the visible shirt-tail has three attached hem points and a narrowed cropped jacket", () => {
  const [shirt, leather] = presets.map((pair) =>
    buildTopMesh(standing, frame, pair[1]),
  );
  const [left, center, right] = shirt.rings.hem;
  assert.ok(center.y > (left.y + right.y) / 2 + 4);
  assert.ok(leather.rings.hem[1].y < center.y - 22);
  const vertices = panel(shirt, "torso");
  for (const pin of [...shirt.rings.waist, ...shirt.rings.hem]) {
    assert.ok(
      vertices.some((v) => Math.hypot(v.t.x - pin.x, v.t.y - pin.y) < 1e-6),
    );
  }
});
test("rig follows asymmetrically tilted hips, and local crop origins consistently affect cuffs too", () => {
  const profile = presets[0][1];
  const offset = buildTopMesh(standing, frame, profile);
  const normalizedFrame = { ...frame, left: 0, top: 0 };
  const zero = buildTopMesh(standing, normalizedFrame, profile);
  zero.vertices.forEach(({ t }, i) => {
    assert.ok(Math.abs(offset.vertices[i].t.x - t.x - frame.left) < 1e-7);
    assert.ok(Math.abs(offset.vertices[i].t.y - t.y - frame.top) < 1e-7);
  });
  const leans = structuredClone(standing);
  leans[24].x -= 0.04;
  leans[24].y -= 0.065;
  const tilted = buildTopMesh(leans, frame, profile);
  assert.ok(tilted.rings.hem[0].y < offset.rings.hem[0].y - 20);
  assert.ok(tilted.rings.waist[1].x < offset.rings.waist[1].x);
  assert.equal(buildTopMesh(standing, frame, profile, null), null);
});
test("a crossing forearm can appear in front of the center placket, or behind it with measured depth", () => {
  const profile = presets[0][1];
  const front = withArm(
    standing,
    12,
    { x: 0.26, y: 0.365 },
    { x: 0.5, y: 0.45, z: -0.1 },
  );
  front[12].z = 0;
  const order = (pose) =>
    buildTopMesh(pose, frame, profile).panels.map(
      (p) => p.region + (p.side ?? ""),
    );
  const a = order(front);
  assert.ok(a.indexOf("torso") < a.indexOf("sleeve0"));
  front[16].z = 0.19;
  const b = order(front);
  assert.ok(b.indexOf("sleeve0") < b.indexOf("torso"));
});

test("a tee photographed with sleeves spread horizontally keeps its cuff transverse on the moving arm", () => {
  const flat = shape("short", "tee");
  flat.aspect = 1.6;
  flat.rows = flat.rows.map((r, i) => {
    const y = i / 64;
    const runs =
      y < 0.12
        ? [[0.36 - y * 0.9, 0.64 + y * 0.9]]
        : y < 0.33
          ? [[0, 1]]
          : [[0.23, 0.77]];
    return { runs, left: runs[0][0], right: runs[0][1] };
  });
  const pattern = {
    neck: { x: 0.5, y: 0.01 },
    shoulders: [
      { x: 0.25, y: 0.09 },
      { x: 0.75, y: 0.09 },
    ],
    pits: [
      { x: 0.26, y: 0.32 },
      { x: 0.74, y: 0.32 },
    ],
    hem: [
      { x: 0.23, y: 1 },
      { x: 0.77, y: 1 },
    ],
    hemCenter: { x: 0.5, y: 1 },
    sleeveLength: "short",
    cuffs: [
      { x: 0.02, y: 0.22 },
      { x: 0.98, y: 0.22 },
    ],
    elbows: [
      { x: 0.14, y: 0.17 },
      { x: 0.86, y: 0.17 },
    ],
  };
  const profile = mapTop(flat, pattern);
  assert.ok(profile.sideData.every((s) => s.sideways));
  const mesh = buildTopMesh(standing, frame, profile);
  for (const side of [0, 1]) {
    const sleeve = panel(mesh, "sleeve", side);
    const [inner, , outer] = sleeve.slice(-3);
    assert.equal(inner.s.x, outer.s.x);
    assert.ok(inner.s.y > outer.s.y + 0.08);
    assert.ok(Math.hypot(inner.t.x - outer.t.x, inner.t.y - outer.t.y) > 12);
  }
});

test("manual shortening keeps the hem below the waist ring on cropped pieces", () => {
  const profile = presets[1][1];
  const mesh = buildTopMesh(standing, frame, profile, undefined, {
    lengthScale: 0.64,
  });
  assert.ok(mesh.rings.waist.every((pin, i) => pin.y < mesh.rings.hem[i].y));
});
