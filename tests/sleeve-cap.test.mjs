import test from "node:test";
import assert from "node:assert/strict";
import { alignSleeveCap } from "../lib/fitting/sleeve-cap.js";

const shoulders = [{ x: 100, y: 100 }, { x: 200, y: 100 }];
const arc = [
  { x: 0.50, y: -0.14 }, { x: 0.55, y: -0.11 },
  { x: 0.60, y: -0.07 }, { x: 0.65, y: -0.02 },
  { x: 0.70, y: 0.04 }, { x: 0.75, y: 0.12 },
];

function sleeve(side, depth = 0) {
  const sign = side ? 1 : -1;
  return Array.from({ length: 10 }, (_, i) =>
    [0, 0.5, 1].map((u) => ({
      s: { x: u, y: i / 9 },
      t: { x: 150 + sign * (45 + 16 * u + 2 * i), y: 100 + depth + 3 * i },
    })),
  );
}

test("both sleeve caps follow the measured outer shoulder without shifting the sewn seam, cuff, or print UVs", () => {
  for (const side of [0, 1]) {
    const rows = sleeve(side);
    const initial = structuredClone(rows);
    alignSleeveCap(rows, side, shoulders, arc, 0.3, 1);
    const sign = side ? 1 : -1;
    assert.ok((rows[0][2].t.x - initial[0][2].t.x) * sign > 2);
    assert.ok(rows[0][2].t.y < initial[0][2].t.y - 2);
    for (let i = 0; i < rows.length; i++) {
      assert.deepEqual(rows[i][0], initial[i][0]);
      assert.deepEqual(rows[i].map(v => v.s), initial[i].map(v => v.s));
      if (i > 2) assert.deepEqual(rows[i], initial[i]);
    }
  }
});

test("a raised, loose or unobserved cap keeps its existing contour", () => {
  const loose = sleeve(0, -28), initial = structuredClone(loose);
  alignSleeveCap(loose, 0, shoulders, arc, 0.55, 1);
  assert.deepEqual(loose, initial);
  for (const observations of [null, [], [arc[0], arc[5]]]) {
    const rows = sleeve(1), original = structuredClone(rows);
    alignSleeveCap(rows, 1, shoulders, observations, 0.55, 1);
    assert.deepEqual(rows, original);
  }
});

test("the contour correction follows the graded shoulder width", () => {
  const small = sleeve(0), large = sleeve(0);
  alignSleeveCap(small, 0, shoulders, arc, 0.3, 0.95);
  alignSleeveCap(large, 0, shoulders, arc, 0.3, 1.04);
  assert.ok(large[0][2].t.x < small[0][2].t.x);
});
