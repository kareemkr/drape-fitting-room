import { NEUTRAL_SIZE_GRADE } from "./garment-size.js";

// Source rows describe the garment in its own flat-lay coordinates. Destination
// positions are in unmirrored video pixels, as reported by the pose tracker.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const along = (a, b, t) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const rightOf = (a, b) => {
  const length = distance(a, b) || 1;
  return { x: (b.y - a.y) / length, y: (a.x - b.x) / length };
};
const offset = (p, axis, n) => ({ x: p.x + axis.x * n, y: p.y + axis.y * n });
const mean = (pair) => along(pair[0], pair[1], 0.5);
const rowAt = (shape, y) =>
  shape.rows[Math.round(clamp(y, 0, 1) * (shape.rows.length - 1))];
const widthOf = (r) => r.right - r.left;
const centerOf = (r) => (r.left + r.right) / 2;

export function landmarkAt(points, index, frame, minimum = 0.48) {
  const p = points?.[index];
  if (
    !p ||
    !Number.isFinite(p.x) ||
    !Number.isFinite(p.y) ||
    (p.confidence ?? Math.min(p.visibility ?? 1, p.presence ?? 1)) < minimum ||
    p.x < -0.015 ||
    p.x > 1.015 ||
    p.y < -0.015 ||
    p.y > 1.015
  )
    return null;
  return { x: p.x * frame.width, y: p.y * frame.height, z: p.z };
}

function alphaRow(pixels, y) {
  const { data, width, height } = pixels;
  const start = Math.round(y * (height - 1)) * width;
  const runs = [];
  let left = -1;
  for (let x = 0; x <= width; x++) {
    const filled = x < width && data[(start + x) * 4 + 3] > 80;
    if (filled && left === -1) left = x;
    if (!filled && left !== -1) {
      if (x - left > width * 0.018) runs.push([left / width, x / width]);
      left = -1;
    }
  }
  const first = runs[0]?.[0] ?? 0.25,
    last = runs.at(-1)?.[1] ?? 0.75;
  // Pants have a gap close to the vertical midline. A gap near an outer
  // edge, such as the air between a sleeve and a bodice, is not a leg split.
  const valid = runs
    .slice(1)
    .map((run, i) => ({
      left: runs[i][1],
      right: run[0],
    }))
    .filter(
      (g) =>
        g.right - g.left > 0.014 &&
        (g.left + g.right) / 2 > 0.37 &&
        (g.left + g.right) / 2 < 0.63 &&
        g.left - first > 0.065 &&
        last - g.right > 0.065,
    );
  const gap = valid.sort((a, b) => b.right - b.left - (a.right - a.left))[0];
  return {
    left: first,
    right: last,
    runs,
    split: gap ? (gap.left + gap.right) / 2 : null,
    gap,
  };
}

// Find sleeves that separate visibly from the bodice on the product itself.
// Their cuffs can extend below the waist of a dress.
function readDressSleeves(rows) {
  const branches = rows.map((row, index) => {
    if (index < 6 || index > 42) return null;
    const torsoIndex = row.runs.findIndex(
      ([left, right]) => left < 0.48 && right > 0.52,
    );
    if (torsoIndex < 0) return null;
    let left = row.runs[torsoIndex - 1],
      right = row.runs[torsoIndex + 1];
    const body = [...row.runs[torsoIndex]];
    left =
      left && left[1] - left[0] > 0.045 && body[0] - left[1] > 0.012
        ? left
        : null;
    right =
      right && right[1] - right[0] > 0.045 && right[0] - body[1] > 0.012
        ? right
        : null;
    if (!left && !right) return null;
    // A shadow can bridge the small cutout on only one side. Recover that
    // missing seam using the width of the sleeve visible on the other side.
    const mid = (row.left + row.right) / 2;
    if (!right) {
      right = [2 * mid - left[1], row.right];
      body[1] = 2 * mid - body[0];
    } else if (!left) {
      left = [row.left, 2 * mid - right[0]];
      body[0] = 2 * mid - body[1];
    }
    return [left, body, right];
  });
  let start = -1,
    end = -1;
  for (let i = 6; i < branches.length; i++) {
    if (branches[i] && branches[i + 1] && branches[i + 2]) {
      start = i;
      end = i + 2;
      while (branches[end + 1] || branches[end + 2])
        end += branches[end + 1] ? 1 : 2;
      break;
    }
  }
  if (start < 0 || end - start < 4) return null;
  const underarm = branches[start],
    root = 3;
  // The sleeve-to-bodice seam joins at the top shoulder and curves down to
  // the underarm. Below the underarm the measured transparent gap divides them.
  const sections = rows.map((row, i) => {
    if (i < root || i > end) return { body: [row.left, row.right] };
    if (i < start) {
      const t = (i - root) / (start - root);
      const left = mix(rows[root].left, underarm[1][0], t);
      const right = mix(rows[root].right, underarm[1][1], t);
      return {
        body: [left, right],
        sleeves: [
          [row.left, Math.max(row.left, left)],
          [Math.min(row.right, right), row.right],
        ],
      };
    }
    const [left, body, right] = branches[i] || branches[i - 1];
    return { body, sleeves: [left, right] };
  });
  return { sections, root: root / 64, underarm: start / 64, cuff: end / 64 };
}

export function readLiveSilhouette(canvas, category, name) {
  const pixels = canvas
    .getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
  const rows = Array.from({ length: 65 }, (_, i) =>
    alphaRow(pixels, clamp(i / 64, 0.012, 0.98)),
  );
  const lowRows = rows.slice(40, 60);
  const hasSplit = lowRows.filter((r) => r.gap).length > lowRows.length * 0.64;
  const description = String(name || "").toLowerCase();
  const separatesLegs =
    category !== "top" &&
    !/skirt|dress|gown/.test(description) &&
    (hasSplit ||
      /\b(trousers?|pants?|denim jeans|jeans|leggings|culottes|shorts|jumpsuit|romper)\b/.test(
        description,
      ));
  const shape = {
    rows,
    separatesLegs,
    description,
    category,
    aspect: canvas.width / canvas.height,
  };
  shape.sleeves = category === "dress" ? readDressSleeves(rows) : null;
  const trunkRows = rows.map((row, i) => {
    const body = shape.sleeves?.sections[i].body;
    return body ? { ...row, left: body[0], right: body[1] } : row;
  });
  shape.trunkRows = trunkRows;
  const middleRows = trunkRows.slice(15, 32);
  const waistIndex = middleRows.reduce(
    (best, r, i) => (widthOf(r) < widthOf(middleRows[best]) ? i : best),
    0,
  );
  // Restrict the seam to the middle of the bodice even on flared skirts and
  // tie belts whose ribbons affect the silhouette width.
  shape.waistY =
    category === "dress" ? clamp((15 + waistIndex) / 64, 0.25, 0.44) : 0;
  const splitIndex = rows.findIndex(
    (r, i) => i > 6 && r.gap && rows[i + 1]?.gap && rows[i + 2]?.gap,
  );
  shape.fork = separatesLegs
    ? clamp(
        splitIndex > 0 ? splitIndex / 64 : category === "dress" ? 0.6 : 0.33,
        category === "dress" ? shape.waistY + 0.12 : 0.18,
        category === "dress" ? 0.79 : 0.55,
      )
    : 1;
  return shape;
}

function geometry(points, frame, category) {
  // Framing and the lower-body mesh must accept the same usable leg points.
  const get = (i) =>
    landmarkAt(points, i, frame, i >= 23 && i <= 28 ? 0.4 : 0.48);
  const ids = get(11)?.x < get(12)?.x ? [11, 12] : [12, 11];
  const shoulders = ids.map(get),
    hips = ids.map((i) => get(i + 12));
  if (![...shoulders, ...hips].every(Boolean)) return null;
  const shoulder = mean(shoulders),
    hip = mean(hips);
  const span = distance(...shoulders),
    torso = distance(shoulder, hip);
  if (
    span < frame.width * 0.05 ||
    torso < span * 0.52 ||
    torso > span * 2.85 ||
    hip.y < shoulder.y ||
    Math.abs(shoulders[0].y - shoulders[1].y) > span * 0.66
  )
    return null;
  const knees = ids.map((i) => get(i + 14)),
    ankles = ids.map((i) => get(i + 16));
  if (category !== "top" && !knees.every(Boolean)) return null;
  // For the top-only fallback the remaining points are never used.
  const arms = ids.map((i) => [get(i), get(i + 2), get(i + 4)]);
  const hipWidth = Math.max(distance(...hips) * 1.36, span * 0.85);
  return {
    shoulders,
    shoulder,
    hips,
    hip,
    span,
    torso,
    hipWidth,
    knees,
    ankles,
    arms,
  };
}

function hemFraction(shape, g, scale, waistY) {
  const description = shape.description;
  if (/\b(micro|mini|shorts|romper)\b/.test(description)) return 0.65; // knee = 1, ankle = 2
  if (/\b(midi|cropped|capri|culottes)\b/.test(description)) return 1.52;
  if (
    /\b(maxi|gown|full.length|floor.length|trousers?|pants?|jeans|jumpsuit|leggings)\b/.test(
      description,
    )
  )
    return 1.99;
  const kneeDistance = Math.max(g.torso * 0.42, distance(g.hip, mean(g.knees)));
  if (shape.separatesLegs) return shape.aspect > 1.13 ? 0.65 : 1.96;
  const naturalDrop = (scale / shape.aspect) * (1 - waistY) - g.torso * 0.22;
  return clamp(naturalDrop / kneeDistance, 0.52, 1.99);
}

function throughLeg(g, i, t) {
  const hip = g.hips[i],
    knee = g.knees[i],
    ankle = g.ankles[i];
  return t <= 1 ? along(hip, knee, t) : along(knee, ankle, t - 1);
}

function gridMesh(shape, g, map, split) {
  const mesh = { vertices: [], triangles: [], shoulders: g.shoulders };
  // Cross-sections are nearly affine across each trouser leg and skirt panel.
  // Extra triangles are only needed where a joined sleeve bends around an arm.
  const cols = shape.category === "bottom" || shape.sleeves ? 2 : 5;
  const count = 22;
  for (const side of [0, 1]) {
    for (let row = 0; row <= count; row++) {
      const y = row / count,
        r = rowAt(shape, y),
        mid = split && y >= shape.fork ? (r.split ?? 0.5) : 0.5;
      for (let col = 0; col <= cols; col++) {
        const body =
          shape.sleeves?.sections[Math.round(y * (shape.rows.length - 1))].body;
        const low = side === 0 ? (body?.[0] ?? 0) : mid;
        const high = side === 0 ? mid : (body?.[1] ?? 1);
        const x = mix(low, high, col / cols);
        const i = mesh.vertices.length;
        mesh.vertices.push({ s: { x, y }, t: map(x, y, side, r) });
        if (row && col) {
          const up = i - cols - 1;
          mesh.triangles.push([up - 1, up, i - 1], [up, i, i - 1]);
        }
      }
    }
  }
  return mesh;
}

export function buildFullBodyMesh(points, frame, shape, grade = NEUTRAL_SIZE_GRADE) {
  const g = geometry(points, frame, shape.category);
  if (!g) return null;
  const top = shape.category !== "bottom",
    onlyTop = shape.category === "top";
  const waistY = onlyTop ? 0.76 : shape.waistY;
  const waistRow =
    shape.trunkRows[
      Math.round(
        (onlyTop ? 0.77 : top ? waistY : 0.055) * (shape.rows.length - 1),
      )
    ];
  const torsoRight = rightOf(g.shoulder, g.hip);
  const hipLine = rightOf(g.shoulder, g.hip);
  const scale = g.hipWidth / clamp(widthOf(waistRow), top ? 0.32 : 0.4, 1);
  const waist = along(g.shoulder, g.hip, top ? 0.69 : 0.8);
  const neck = along(g.shoulder, g.hip, -0.15);
  const sourceCenter = centerOf(waistRow);
  const stop = onlyTop ? 0 : hemFraction(shape, g, scale, waistY);
  const waistToHip = distance(waist, g.hip);
  const half = Math.max(g.span * 0.4, waistToHip);
  const kneeDistance = onlyTop ? 0 : distance(g.hip, mean(g.knees));
  const length = waistToHip + Math.max(half, kneeDistance * stop);
  const hipLevel = Math.min(0.85, waistToHip / Math.max(1, length));
  const forkLevel = (shape.fork - waistY) / (1 - waistY);
  // Finished length and inseam share the hem on a pair of trousers. Apply
  // their difference above the crotch, keeping the waistband where it was.
  const dressLength = length + (top ? distance(neck, waist) : 0);
  const lengthDelta = dressLength * (grade.length - 1);
  const inseamDelta = (1 - forkLevel) * length * (grade.legLength - 1);
  const riseDelta = clamp(lengthDelta - inseamDelta, -0.65 * forkLevel * length, forkLevel * length);
  function gradedDrop(relative) {
    const extra = shape.separatesLegs
      ? Math.min(1, relative / Math.max(0.01, forkLevel)) * riseDelta +
        Math.max(0, relative - forkLevel) * length * (grade.legLength - 1)
      : relative * lengthDelta;
    return relative * length + extra;
  }
  const hemLegFraction = (gradedDrop(1) - waistToHip) / Math.max(1, length - waistToHip) * stop;
  if (!onlyTop && hemLegFraction > 1 && !g.ankles.every(Boolean)) return null;
  const splitBlend = Math.max(0.07, (1 - shape.fork) * 0.22);
  function position(x, y, side, r) {
    if (onlyTop || (top && y <= waistY)) {
      const v = y / waistY;
      const center = along(neck, waist, v);
      // The shoulder line widens from the waist according to the reference.
      const shoulderZone =
        shape.category === "dress" && !shape.sleeves
          ? clamp((Math.abs(x - sourceCenter) - 0.105) / 0.21, 0, 1) * (1 - v)
          : 0;
      const bodyWidth = v < 0.48
        ? mix(grade.shoulder, grade.chest, v / 0.48)
        : mix(grade.chest, grade.waist, (v - 0.48) / 0.52);
      const h = (x - sourceCenter) * scale * (1 + 0.11 * shoulderZone);
      const base = offset(center, torsoRight, h * bodyWidth);
      // The shoulder landmark is inside the joint. Extend the outer seam up
      // to the shoulder surface, tapering back to the garment's natural waist.
      base.x += (g.shoulder.x - g.hip.x) * 0.145 * shoulderZone;
      base.y += (g.shoulder.y - g.hip.y) * 0.145 * shoulderZone;
      const limb = g.arms[side];
      if (shape.sleeves || !limb[1] || !limb[2] || v > 0.99) return base;
      const sign = side ? 1 : -1;
      const sleeveX = Math.abs(h) / g.span;
      const sleeve =
        clamp((sleeveX - 0.39) / 0.19, 0, 1) *
        clamp(v / 0.42, 0, 1) *
        clamp((1.12 - v) / 0.24, 0, 1);
      if (sleeve <= 0) return base;
      const t = clamp(v * 1.14 * grade.sleeveLength, 0, 1.65);
      const arm =
        t <= 1 ? along(limb[0], limb[1], t) : along(limb[1], limb[2], t - 1);
      return along(
        base,
        offset(arm, torsoRight, sign * (sleeveX - 0.59) * g.span * grade.sleeveWidth),
        sleeve,
      );
    }
    const relative = (y - waistY) / (1 - waistY);
    const drop = gradedDrop(relative);
    const t = ((drop - waistToHip) / Math.max(1, length - waistToHip)) * stop;
    const widthGrade = relative < hipLevel
      ? mix(grade.waist, grade.hip, relative / Math.max(0.01, hipLevel))
      : mix(grade.hip, grade.legWidth, (relative - hipLevel) / (1 - hipLevel));
    const leg = (i) =>
      t < 0
        ? along(
            waist,
            g.hips[i],
            clamp(1 + (t * kneeDistance) / waistToHip, 0, 1),
          )
        : throughLeg(g, i, t);
    const legs = [leg(0), leg(1)];
    let center = mean(legs);
    if (t < 0)
      center = along(
        waist,
        g.hip,
        clamp(drop / waistToHip, 0, 1),
      );
    const fabricRight = t <= 0 ? hipLine : rightOf(g.hip, mean(g.knees));
    const common = offset(center, fabricRight, (x - sourceCenter) * scale * widthGrade);
    if (!shape.separatesLegs || y < shape.fork) return common;
    const mid = r.split ?? 0.5;
    const outer = side ? r.right : r.left,
      inner = side ? (r.gap?.right ?? mid) : (r.gap?.left ?? mid);
    const srcMid = (outer + inner) * 0.5;
    const chain =
      t <= 1 ? [g.hips[side], g.knees[side]] : [g.knees[side], g.ankles[side]];
    const lateral = rightOf(...chain);
    const separate = offset(legs[side], lateral, (x - srcMid) * scale * grade.legWidth);
    const blend = clamp((y - shape.fork) / splitBlend, 0, 1);
    return along(common, separate, blend * blend * (3 - 2 * blend));
  }
  const mesh = gridMesh(shape, g, position, shape.separatesLegs);
  mesh.pivot = top ? neck : waist;
  if (shape.sleeves) {
    const { sections, root, underarm, cuff } = shape.sleeves;
    const peak = Math.round(cuff * 64);
    for (const side of [0, 1]) {
      const limb = g.arms[side];
      let previous = null;
      for (let i = Math.round(root * 64); i <= peak; i++) {
        const y = i / 64;
        const [left, right] = sections[i].sleeves[side];
        const progress = (y - root) / (cuff - root);
        const front = side === 0 ? right : left;
        let center, axis;
        if (limb.every(Boolean)) {
          const upper = distance(limb[0], limb[1]),
            lower = distance(limb[1], limb[2]);
          const reach = progress * (upper + lower * 0.97) * grade.sleeveLength;
          const start = reach <= upper ? 0 : 1;
          center = along(
            limb[start],
            limb[start + 1],
            start
              ? (reach - upper) / Math.max(1, lower)
              : reach / Math.max(1, upper),
          );
          axis = rightOf(limb[start], limb[start + 1]);
        }
        const pair = [left, right].map((x) => {
          const body = position(x, y, side, rowAt(shape, y));
          const separate = center
            ? offset(center, axis, (x - (left + right) * 0.5) * scale * grade.sleeveWidth)
            : body;
          // Keep the inner upper sleeve sewn to the bodice, then release its
          // cross-section onto the elbow-to-wrist chain below the armhole.
          const edge = clamp(
            Math.abs(x - front) / Math.max(0.01, right - left),
            0,
            1,
          );
          const bend = clamp((y - root) / (underarm - root), 0, 1);
          const free = clamp((y - underarm) / 0.055, 0, 1);
          const t = free + (1 - free) * edge * bend;
          mesh.vertices.push({ s: { x, y }, t: along(body, separate, t) });
          return mesh.vertices.length - 1;
        });
        if (previous)
          mesh.triangles.push(
            [previous[0], previous[1], pair[0]],
            [previous[1], pair[1], pair[0]],
          );
        previous = pair;
      }
    }
  }
  return mesh;
}
