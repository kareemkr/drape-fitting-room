import { landmarkAt } from "./live-fullbody.js";
import { alignSleeveCap } from "./sleeve-cap.js";
import { NEUTRAL_SIZE_GRADE } from "./garment-size.js";
import { deriveLiveWaist } from "./live-waist.js";
export { mapTop, mapTop as mapLongTop } from "./top-pattern.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, t) => a + (b - a) * t;
const at = (a, b, t) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const add = (p, dir, n) => ({ x: p.x + dir.x * n, y: p.y + dir.y * n });
const unit = (a, b) => {
  const d = dist(a, b) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
};
const smooth = (v) => {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
};
const scale = (v) => clamp(Number.isFinite(v) ? v : 1, 0.55, 1.65);
const measured = (v, lo, hi, fallback) =>
  Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

function appendPanel(mesh, { rows, region, side }) {
  if (rows.length < 2) return;
  const firstVertex = mesh.vertices.length,
    firstTriangle = mesh.triangles.length,
    n = rows[0].length;
  for (const row of rows) mesh.vertices.push(...row);
  for (let j = 1; j < rows.length; j++)
    for (let i = 1; i < n; i++) {
      const k = firstVertex + j * n + i;
      mesh.triangles.push([k - n - 1, k - n, k - 1], [k - n, k, k - 1]);
    }
  mesh.panels.push({
    region,
    side,
    firstVertex,
    vertexCount: rows.length * n,
    firstTriangle,
    triangleCount: mesh.triangles.length - firstTriangle,
  });
}

// The cross-sections blend the bilateral attachment points at the appropriate
// anatomical height. Shoulder tilt falls off toward the independently tilted hips.
function torsoControls(body, points, profile, fit, grade) {
  const { shoulders, hips, waist, waistFraction } = body;
  const span = dist(...shoulders),
    hipSpan = dist(...hips),
    waistSpan = dist(...waist);
  const shoulderMid = at(...shoulders, 0.5),
    hipMid = at(...hips, 0.5);
  const shoulderScale = scale(fit.shoulderScale) * grade.shoulder,
    torsoScale = scale(fit.torsoScale),
    lengthScale = scale(fit.lengthScale) * grade.length;
  function section(v, q, halfWidth) {
    const pair =
      v <= waistFraction
        ? shoulders.map((s, i) => at(s, waist[i], v / waistFraction))
        : waist.map((w, i) =>
            at(w, hips[i], (v - waistFraction) / (1 - waistFraction)),
          );
    return add(at(...pair, 0.5), unit(...pair), q * halfWidth * span);
  }
  const widths = [0, 1].map((i) => {
    const outline = points.outline?.[i ? "right" : "left"];
    const cap = measured(outline?.shoulder, 0.54, 0.78, 0.657);
    const chest = measured(
      outline?.chest,
      0.4,
      0.8,
      clamp(0.505 + 0.075 * (hipSpan / span), 0.52, 0.61),
    );
    const waistWidth = measured(
      outline?.waist,
      0.38,
      0.82,
      clamp((0.64 * waistSpan) / span, 0.456, 0.67),
    );
    return {
      cap: (cap - 0.013) * shoulderScale,
      chest: (chest + 0.017) * torsoScale * grade.chest,
      waist: (waistWidth + 0.015) * torsoScale * grade.waist,
      hem:
        (Math.max(
          waistWidth * 0.99,
          clamp((0.65 * hipSpan) / span, 0.435, 0.73),
        ) *
          profile.flare +
          0.015) *
        torsoScale * grade.hip,
    };
  });
  const knots = profile.columns.map((c) => {
    const q = c.q,
      u = c.u,
      w = widths[c.side];
    let capV = -0.073 - 0.1 * smooth(u / 0.7) + 0.1 * Math.pow(u, 2.5);
    let topV = -0.248 + 0.046 * Math.pow(u, 1.9);
    const arc = points.outline?.[c.side ? "right" : "left"]?.shoulderArc;
    if (arc?.length >= 3 && u > 0.3 && c.topY >= 0) {
      const x = (u * w.cap) / shoulderScale;
      const i = clamp(
        arc.findIndex((point) => point.x >= x),
        1,
        arc.length - 1,
      );
      const before = x >= arc.at(-1).x ? arc.at(-2) : arc[i - 1];
      const after = x >= arc.at(-1).x ? arc.at(-1) : arc[i];
      const surface =
        mix(
          before.y,
          after.y,
          clamp(
            (x - before.x) / Math.max(0.015, after.x - before.x),
            -0.5,
            1.4,
          ),
        ) - 0.011;
      const atTop = mix(
        topV,
        capV,
        clamp(c.topY / Math.max(0.045, c.cap.y), 0, 1),
      );
      const offset =
        clamp(
          (surface * span) / dist(shoulderMid, hipMid) - atTop,
          -0.072,
          0.045,
        ) * smooth((u - 0.3) / 0.22);
      capV += offset;
      topV += offset;
    }
    const hemV = -0.17 + (c.vEnd + 0.17) * lengthScale;
    const waistV = Math.min(c.waistV, mix(0.23, hemV, 0.8));
    return [
      section(topV, q, w.cap),
      section(capV, q, w.cap),
      section(0.23, q, w.chest),
      section(waistV, q, w.waist),
      section(hemV, q, w.hem),
    ];
  });
  return { knots, span, shoulderMid, hipMid };
}

function sampleJoint(points, index, frame) {
  const p = landmarkAt(points, index, frame);
  return p && { ...p, x: p.x + (frame.left || 0), y: p.y + (frame.top || 0) };
}

function sleevePanel(side, points, frame, body, profile, controls, fit, grade) {
  const { rings, cap, pit, cuff, sideways } = profile.sideData[side],
    { span, knots } = controls;
  if (rings.length < 2) return null;
  const sign = side ? 1 : -1,
    id = body.ids[side],
    shoulder = body.shoulders[side];
  const vertical = unit(controls.shoulderMid, controls.hipMid);
  const horizontal = unit(...body.shoulders);
  let elbow = sampleJoint(points, id + 2, frame),
    wrist = sampleJoint(points, id + 4, frame);
  if (
    elbow &&
    (dist(shoulder, elbow) > 1.4 * span || dist(shoulder, elbow) < 0.08 * span)
  )
    elbow = null;
  if (!elbow)
    elbow = add(
      add(shoulder, vertical, 0.69 * span),
      horizontal,
      sign * 0.11 * span,
    );
  if (
    wrist &&
    (dist(elbow, wrist) > 1.4 * span || dist(elbow, wrist) < 0.065 * span)
  )
    wrist = null;
  const upper = unit(shoulder, elbow);
  // A missing arm joint can affect only its own sleeve. Extend the observed
  // upper arm to retain a natural unloaded sleeve during a brief wrist dropout.
  const wristMeasured = Boolean(wrist);
  if (!wrist)
    wrist = add(
      elbow,
      upper,
      clamp(dist(shoulder, elbow) * 0.91, 0.43 * span, 0.86 * span),
    );
  const lower = unit(elbow, wrist),
    long = profile.sleeveLength === "long";
  const reach = scale(fit.sleeveScale) * grade.sleeveLength;
  const elbowUV = clamp(
    (profile.a.elbows[side].y - cap.y) / Math.max(0.08, cuff.y - cap.y),
    0.3,
    0.7,
  );
  const shoulderAxis = unit(...body.shoulders);
  const edgeKnots = knots[side ? knots.length - 1 : 0];
  const outline = points.outline?.[side ? "right" : "left"];
  const upperRadius =
    span * (measured(outline?.upperArm, 0.135, 0.235, 0.174) + 0.009);
  const middleRadius =
    span *
    (measured(
      outline?.forearm,
      0.108,
      0.21,
      Math.max(0.141, (upperRadius / span) * 0.8),
    ) +
      0.008);
  const endRadius =
    span *
    (measured(
      outline?.wrist,
      0.072,
      0.155,
      Math.max(0.094, (upperRadius / span) * 0.52),
    ) +
      0.005);
  const outsideForearm =
    span * measured(outline?.outerForearm, 0.07, 0.245, middleRadius / span);
  const outsideWrist =
    span * measured(outline?.outerWrist, 0.045, 0.215, endRadius / span);
  const outsideBend = Math.max(
    0,
    sign * (upper.x * lower.y - upper.y * lower.x),
  );
  const shortReach = clamp(
    (Math.hypot(cuff.y - cap.y, (cuff.x - cap.x) * profile.aspect) /
      Math.max(0.3, profile.a.hemCenter.y - cap.y)) *
      1.4,
    0.31,
    0.84,
  );
  const rows = rings.map((r) => {
    const t =
      r.t ?? clamp((r.y - cap.y) / Math.max(0.06, cuff.y - cap.y), 0, 1.05);
    const armT = long
      ? (t <= elbowUV ? t / elbowUV : 1 + (t - elbowUV) / (1 - elbowUV)) * reach
      : t * shortReach * reach;
    const bend = long ? smooth((armT - 0.82) / 0.36) : 0,
      along =
        armT < 1 || !long
          ? at(shoulder, elbow, armT)
          : at(elbow, wrist, Math.min(armT - 1, 1.3));
    const blended = {
      x: mix(upper.x, lower.x, bend),
      y: mix(upper.y, lower.y, bend),
    };
    const magnitude = Math.hypot(blended.x, blended.y);
    const direction =
      magnitude > 0.18
        ? { x: blended.x / magnitude, y: blended.y / magnitude }
        : armT < 1
          ? upper
          : lower;
    const across = { x: direction.y, y: -direction.x };
    // Outline radii are measured near the middle of each limb segment. An
    // elbow should not already be as narrow as the center of the forearm.
    const radiusAt = (middle, end) =>
      armT < 1.38
        ? mix(upperRadius, middle, smooth((armT - 0.47) / 0.91))
        : mix(middle, end, smooth((armT - 1.38) / 0.59));
    const innerRadius = radiusAt(middleRadius, endRadius);
    const corner =
      1 + 0.15 * outsideBend * smooth(1 - Math.abs(armT - 1) / 0.28);
    const outerRadius =
      radiusAt(
        Math.max(middleRadius, outsideForearm),
        Math.max(endRadius, outsideWrist),
      ) * corner;
    const seamT = sideways ? 0 : (r.y - cap.y) / Math.max(0.07, pit.y - cap.y);
    const seam =
      seamT < 0
        ? at(
            edgeKnots[0],
            edgeKnots[1],
            clamp(r.y / Math.max(0.03, cap.y), 0, 1),
          )
        : at(edgeKnots[1], edgeKnots[2], clamp(seamT, 0, 1));
    return [0, 0.5, 1].map((u) => {
      const bone = add(along, across, sign * grade.sleeveWidth * mix(-innerRadius, outerRadius, u));
      if (sideways) {
        const root = at(edgeKnots[2], edgeKnots[1], u);
        return {
          s: at(r.lower, r.upper, u),
          t: at(root, bone, smooth(t / 0.39)),
        };
      }
      const stitch =
        (1 - smooth((seamT - 0.77) / 0.63)) *
        (1 - u * smooth((seamT + 0.125) / 0.64));
      const crown = add(seam, shoulderAxis, sign * u * span * 0.026);
      return {
        s: { x: mix(r.inner, r.outer, u), y: r.y },
        t: at(bone, crown, stitch),
      };
    });
  });
  alignSleeveCap(rows, side, body.shoulders, outline?.shoulderArc,
    long ? 0.30 : 0.55, scale(fit.shoulderScale) * grade.shoulder);
  const wristCrosses = (wrist.x - controls.shoulderMid.x) * sign < span * 0.46;
  const elbowCrosses = (elbow.x - controls.shoulderMid.x) * sign < span * 0.36;
  const z = points[id + 4]?.z,
    chestZ = points[id]?.z;
  const behind =
    Number.isFinite(z) &&
    Number.isFinite(chestZ) &&
    z > chestZ + (span / frame.width) * 0.18;
  return {
    rows,
    side,
    region: "sleeve",
    front: !behind && (elbowCrosses || (wristMeasured && long && wristCrosses)),
    depth: Number.isFinite(z) ? z : 0,
  };
}

export function buildTopMesh(
  points,
  frame,
  profile,
  body = deriveLiveWaist(points, frame),
  fit = {},
  grade = NEUTRAL_SIZE_GRADE,
) {
  if (!body || !profile) return null;
  const controls = torsoControls(body, points, profile, fit, grade);
  const rows = profile.rows.map((row) =>
    row.map(({ s, part, t }, i) => ({
      s,
      t: at(controls.knots[i][part], controls.knots[i][part + 1], t),
    })),
  );
  const sleeves = [0, 1]
    .map((side) =>
      sleevePanel(side, points, frame, body, profile, controls, fit, grade),
    )
    .filter(Boolean);
  const mesh = {
    vertices: [],
    triangles: [],
    panels: [],
    shoulders: body.shoulders,
  };
  for (const sleeve of sleeves.filter((p) => !p.front))
    appendPanel(mesh, sleeve);
  appendPanel(mesh, { region: "torso", side: null, rows });
  for (const sleeve of sleeves
    .filter((p) => p.front)
    .sort((a, b) => b.depth - a.depth))
    appendPanel(mesh, sleeve);
  const middle = Math.floor(controls.knots.length / 2);
  const ring = (index) =>
    [0, middle, controls.knots.length - 1].map((i) => controls.knots[i][index]);
  mesh.rings = { waist: ring(3), hem: ring(4) };
  return mesh;
}

// Kept for consumers of the original live-preview API.
export { buildTopMesh as buildLongTopMesh };
