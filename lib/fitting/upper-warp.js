// Coordinates at this boundary are cutout fractions (source) and photo-frame pixels (target).
// Points are detected joint centers; clothing attaches at the skin/cloth surface, outside those centers.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, t) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
const add = (p, u, x, v = { x: 0, y: 0 }, y = 0) => ({
  x: p.x + x * u.x + y * v.x,
  y: p.y + x * u.y + y * v.y,
});
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const direction = (a, b) => {
  const d = dist(a, b) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
};
const normal = (u) => ({ x: -u.y, y: u.x });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const finitePoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const cross = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const adjustment = (v) => clamp(Number.isFinite(v) ? v : 1, 0.55, 1.65);
function mapJoint(points, index, frame, threshold = 0.5) {
  const p = points[index];
  if (
    !finitePoint(p) ||
    (p.confidence ?? Math.min(p.visibility ?? 1, p.presence ?? 1)) <
      threshold ||
    p.x < -0.06 ||
    p.x > 1.06 ||
    p.y < -0.08 ||
    p.y > 1.08
  )
    return null;
  return {
    x: frame.left + p.x * frame.width,
    y: frame.top + p.y * frame.height,
  };
}
function anatomyValid(a) {
  return (
    a &&
    finitePoint(a.neck) &&
    [a.shoulders, a.pits, a.hem, a.neckSides].every(
      (pair) => pair?.length === 2 && pair.every(finitePoint),
    ) &&
    (a.sleeveLength === "sleeveless" ||
      [a.elbows, a.cuffs].every(
        (pair) => pair?.length === 2 && pair.every(finitePoint),
      ))
  );
}
function subject(points, photo) {
  if (!points || points.length < 33 || !(photo?.width > 0 && photo?.height > 0))
    return null;
  const sides = [11, 12].map((index) => ({
    index,
    joint: mapJoint(points, index, photo, 0.52),
  }));
  if (sides.some((s) => !s.joint)) return null;
  sides.sort((a, b) => a.joint.x - b.joint.x);
  const shoulders = sides.map((s) => s.joint);
  const span = dist(...shoulders);
  if (
    span < photo.width * 0.05 ||
    span > photo.width * 1.08 ||
    Math.abs(shoulders[1].y - shoulders[0].y) > span * 0.62
  )
    return null;
  const horizontal = direction(...shoulders),
    vertical = normal(horizontal),
    center = mix(...shoulders, 0.5);
  const hips = sides.map(({ index }) =>
    mapJoint(points, index + 12, photo, 0.48),
  );
  const hasHips = hips.every(Boolean);
  const pelvis = hasHips
    ? mix(...hips, 0.5)
    : add(center, vertical, span * 1.4);
  const torso =
    (pelvis.x - center.x) * vertical.x + (pelvis.y - center.y) * vertical.y;
  if (torso < span * 0.59 || torso > span * 2.75) return null;
  const hipSpan = hasHips
    ? clamp(dist(...hips), span * 0.39, span * 1.52)
    : span * 0.73;
  // Sideways lean belongs in the body axis. Shoulder slant belongs in each cross-section.
  const axis = {
    x: (pelvis.x - center.x) / torso,
    y: (pelvis.y - center.y) / torso,
  };
  return {
    sides,
    shoulders,
    span,
    horizontal,
    vertical,
    center,
    pelvis,
    hipSpan,
    torso,
    axis,
  };
}
function armPath(points, photo, body, side, sign) {
  const { span, horizontal, vertical, torso } = body;
  const shoulder = side.joint;
  let elbow = mapJoint(points, side.index + 2, photo, 0.48);
  let wrist = mapJoint(points, side.index + 4, photo, 0.48);
  if (
    elbow &&
    (dist(shoulder, elbow) > span * 1.28 || dist(shoulder, elbow) < span * 0.09)
  )
    elbow = null;
  if (wrist && dist(shoulder, wrist) > span * 2.4) wrist = null;
  if (!elbow) {
    elbow = wrist
      ? add(mix(shoulder, wrist, 0.52), horizontal, sign * span * 0.055)
      : add(shoulder, horizontal, sign * span * 0.085, vertical, torso * 0.49);
  }
  if (wrist && dist(elbow, wrist) > span * 1.17) wrist = null;
  if (!wrist) {
    const guessed = direction(shoulder, elbow);
    wrist = add(
      elbow,
      guessed,
      clamp(dist(shoulder, elbow) * 0.94, span * 0.4, span * 0.81),
    );
  }
  return { shoulder, elbow, wrist };
}
function measured(outline, key, lo, hi, fallback) {
  const v = outline?.[key];
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}
function pointAlongArm(path, fraction) {
  const l1 = dist(path.shoulder, path.elbow),
    l2 = dist(path.elbow, path.wrist);
  const traveled = (l1 + l2) * fraction;
  return traveled < l1
    ? mix(path.shoulder, path.elbow, traveled / (l1 || 1))
    : mix(path.elbow, path.wrist, (traveled - l1) / (l2 || 1));
}
// Source-space Delaunay connectivity keeps each collar, underarm, elbow, cuff and hem fixed
// as a control point. New positions never influence which piece of fabric is sampled.
function triangulate(vertices, ratio) {
  const q = vertices.map((p) => ({ x: p.s.x * ratio, y: p.s.y }));
  const n = q.length;
  const span = Math.max(2, ratio);
  q.push(
    { x: -16 * span, y: -16 * span },
    { x: 32 * span, y: -16 * span },
    { x: 0, y: 32 * span },
  );
  function triangle(a, b, c) {
    if (cross(q[a], q[b], q[c]) < 0) [b, c] = [c, b];
    const A = q[a],
      B = q[b],
      C = q[c];
    const bx = B.x - A.x,
      by = B.y - A.y,
      cx = C.x - A.x,
      cy = C.y - A.y,
      det = 2 * (bx * cy - by * cx);
    if (Math.abs(det) < 1e-11) return null;
    const u = ((bx * bx + by * by) * cy - (cx * cx + cy * cy) * by) / det;
    const v = (bx * (cx * cx + cy * cy) - cx * (bx * bx + by * by)) / det;
    return { a, b, c, x: A.x + u, y: A.y + v, r2: u * u + v * v };
  }
  let faces = [triangle(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const keep = [],
      edges = new Map();
    for (const t of faces) {
      if ((q[i].x - t.x) ** 2 + (q[i].y - t.y) ** 2 > t.r2 + 1e-12) {
        keep.push(t);
        continue;
      }
      for (const [a, b] of [
        [t.a, t.b],
        [t.b, t.c],
        [t.c, t.a],
      ]) {
        const key = a < b ? a * 1024 + b : b * 1024 + a;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [a, b]);
      }
    }
    for (const [a, b] of edges.values()) {
      const t = triangle(a, b, i);
      if (t) keep.push(t);
    }
    faces = keep;
  }
  return faces
    .filter((t) => t.a < n && t.b < n && t.c < n)
    .map(({ a, b, c }) => [a, b, c]);
}
const topologyCache = new WeakMap();
function shoulderHeight(outline, x) {
  const fallback = [
    { x: 0.16, y: -0.32 },
    { x: 0.32, y: -0.24 },
    { x: 0.47, y: -0.16 },
    { x: 0.58, y: -0.095 },
    { x: 0.66, y: -0.012 },
    { x: 0.74, y: 0.12 },
  ];
  const arc =
    outline?.shoulderArc?.length >= 3 ? outline.shoulderArc : fallback;
  const upper = arc.findIndex((p) => p.x >= x);
  const j = upper < 0 ? arc.length - 1 : Math.max(1, upper);
  const l = arc[j - 1],
    r = arc[j];
  return l.y + (r.y - l.y) * clamp((x - l.x) / (r.x - l.x), -1.4, 1.65);
}
function sourceTop(a, x, fallback) {
  return typeof a.topAt === "function" ? (a.topAt(x) ?? fallback) : fallback;
}
function sleeveLimits(a, i, y, outer, inner) {
  const row = typeof a.edgeAt === "function" ? a.edgeAt(i, y) : null;
  return row && finitePoint(row.outer) && finitePoint(row.inner)
    ? row
    : { outer, inner };
}

function sleeveBoundary(center, from, to, halfWidth, sign, ratio) {
  const u = direction(
    { x: from.x * ratio, y: from.y },
    { x: to.x * ratio, y: to.y },
  );
  const outside = { x: u.y * sign, y: -u.x * sign };
  return add(center, { x: outside.x, y: outside.y * ratio }, halfWidth);
}
function targetBoundary(center, from, to, radius, sign) {
  const u = direction(from, to);
  return add(center, { x: u.y * sign, y: -u.x * sign }, radius);
}
// Short sleeves and open armholes are cut in one continuous shape. A monotonic strip mesh
// keeps the transparent armholes and fabric edge intact, even when a sleeve is only a few pixels tall.
function buildShortMesh(points, photo, a, body, options) {
  const { center, span, torso, horizontal, axis } = body;
  const tank = a.sleeveLength === "sleeveless";
  const torsoScale = adjustment(options.torsoScale),
    shoulderScale = adjustment(options.shoulderScale);
  const lengthScale = adjustment(options.lengthScale),
    reach = adjustment(options.sleeveScale);
  const levels = [0, 0.07, 0.15, 0.25, 0.36, 0.48, 0.64, 0.82, 1];
  const columns = [
    0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.5, 0.6, 0.68, 0.76, 0.84, 0.92, 1,
  ];
  const start = tank ? -0.105 : -0.186;
  const dxPoint = (x, y) => add(center, horizontal, x * span, axis, y * torso);
  const sides = body.sides.map((side, i) => {
    const sign = i ? 1 : -1,
      outline = points.outline?.[i ? "right" : "left"];
    const chest = measured(outline, "chest", 0.38, 0.83, 0.515) + 0.021;
    const waist = measured(outline, "waist", 0.35, 0.86, 0.455) + 0.02;
    const upper =
      measured(outline, "shoulder", 0.53, 0.83, 0.625) * shoulderScale;
    const path = armPath(points, photo, body, side, sign);
    return { sign, chest, waist, upper, path };
  });
  function torsoPoint(x, y) {
    const i = x < 0.5 ? 0 : 1,
      { sign, chest, waist, upper } = sides[i];
    const pitX = a.pits[i].x,
      hemX = a.hem[i].x;
    const edgeX = pitX + (hemX - pitX) * clamp((y - 0.38) / 0.62, 0, 1);
    const sideFraction = clamp(Math.abs(edgeX - 0.5), 0.21, 0.5);
    const shoulderBlend = clamp(1 - y / 0.35, 0, 1);
    const halfWidth =
      (chest + (waist - chest) * clamp((y - 0.35) / 0.65, 0, 1)) * torsoScale;
    const fromCenter = Math.abs(x - 0.5);
    let width;
    if (tank) {
      width = fromCenter * 2 * (halfWidth * 0.99 + shoulderBlend * 0.04);
    } else {
      const acrossBody = Math.min(1, fromCenter / sideFraction);
      const extension = clamp(
        (fromCenter - sideFraction) / Math.max(0.05, 0.5 - sideFraction),
        0,
        1,
      );
      width =
        halfWidth * acrossBody +
        extension * (Math.max(halfWidth + 0.135, upper + 0.09) - halfWidth);
    }
    const yBody = start + y * (1.055 - start) * lengthScale;
    return dxPoint(
      width * sign,
      yBody +
        shoulderBlend * (tank ? 0.012 : 0.072) * Math.pow(fromCenter * 2, 1.8),
    );
  }
  function warpPoint(x, y) {
    const raw = torsoPoint(x, y);
    if (tank) return raw;
    const i = x < 0.5 ? 0 : 1,
      side = sides[i],
      cuff = a.cuffs[i];
    const sourceShoulder = a.shoulders[i];
    const srcReach = clamp(
      dist(sourceShoulder, cuff) /
        Math.max(0.2, dist(sourceShoulder, a.hem[i])),
      0.2,
      0.82,
    );
    const dest = pointAlongArm(
      side.path,
      clamp((0.22 + srcReach * 0.34) * reach, 0.17, 0.7),
    );
    const home = torsoPoint(cuff.x, cuff.y);
    const outside = clamp(
      ((x - a.pits[i].x) * side.sign) /
        Math.max(0.06, (cuff.x - a.pits[i].x) * side.sign),
      0,
      1,
    );
    const nearSleeve = clamp((y + 0.035) / Math.max(0.09, cuff.y), 0, 1);
    const influence = outside * outside * (3 - 2 * outside) * nearSleeve;
    return {
      x: raw.x + clamp(dest.x - home.x, -span * 0.58, span * 0.58) * influence,
      y: raw.y + clamp(dest.y - home.y, -span * 0.62, span * 0.62) * influence,
    };
  }
  const vertices = [],
    triangles = [];
  levels.forEach((y, row) =>
    columns.forEach((x, col) => {
      const n = vertices.length;
      vertices.push({ s: { x, y }, t: warpPoint(x, y), zone: 0 });
      if (row && col) {
        const ul = n - columns.length - 1,
          ur = ul + 1,
          ll = n - 1;
        triangles.push([ul, ur, ll], [ur, n, ll]);
      }
    }),
  );
  return {
    cx: (body.center.x + body.pelvis.x) / 2,
    cy: (body.center.y + body.pelvis.y) / 2,
    vertices,
    triangles,
    shoulders: a.shoulders.map((p) => warpPoint(p.x, p.y)),
    pits: a.pits.map((p) => warpPoint(p.x, p.y)),
    hem: a.hem.map((p) => warpPoint(p.x, p.y)),
    span,
    neckOpening: a.neckOpening,
    frame: photo,
  };
}
/** Build a deformable mesh for an alpha-isolated front-facing top. Returns null if evidence is insufficient. */
export function buildUpperMesh(points, photo, a, options = {}) {
  if (!anatomyValid(a)) return null;
  const body = subject(points, photo);
  if (!body) return null;
  if (a.sleeveLength !== "long")
    return buildShortMesh(points, photo, a, body, options);
  const { span, horizontal, vertical, center, torso, hipSpan, axis } = body;
  const ratio = clamp(options.garmentRatio || 0.85, 0.24, 3.5);
  const shoulderScale = adjustment(options.shoulderScale),
    torsoScale = adjustment(options.torsoScale);
  const sleeveScale = adjustment(options.sleeveScale),
    lengthScale = adjustment(options.lengthScale);
  const section = (t, width) =>
    add(center, axis, t * torso, horizontal, width * span);
  const vertices = [];
  function put(s, t, zone = 0) {
    if (!finitePoint(s) || !finitePoint(t)) return;
    // Coincident sleeve/torso anchors represent one seam.
    if (
      vertices.some((v) => (v.s.x - s.x) ** 2 + (v.s.y - s.y) ** 2 < 0.000015)
    )
      return;
    vertices.push({ s, t, zone });
  }
  const hood = a.hemCenter || mix(...a.hem, 0.5);
  const sleeveEnd = (a.cuffs[0].y + a.cuffs[1].y) * 0.5;
  const garmentDrop = clamp(
    (hood.y - a.neck.y) / Math.max(0.2, sleeveEnd - a.neck.y),
    0.52,
    1.24,
  );
  const hemLevel =
    -0.18 + lengthScale * clamp(1.27 + (garmentDrop - 0.98) * 1.02, 0.82, 1.52);
  const neckCenter = section(-0.205, 0);
  const sourceShoulderMid = mix(...a.shoulders, 0.5),
    sourcePitMid = mix(...a.pits, 0.5);
  const neckHalf = clamp(
    ((a.neckSides[1].x - a.neckSides[0].x) /
      Math.max(0.23, a.shoulders[1].x - a.shoulders[0].x)) *
      0.48,
    0.145,
    0.276,
  );
  const chestLevel = 0.31,
    waistLevel = chestLevel + (hemLevel - chestLevel) * 0.63;
  const hemEnds = [],
    pits = [],
    shoulderEnds = [];
  put(a.neck, neckCenter);
  put(sourceShoulderMid, section(-0.066, 0));
  put(sourcePitMid, section(chestLevel, 0));
  put(mix(sourcePitMid, hood, 0.63), section(waistLevel, 0));
  put(hood, section(hemLevel, 0));
  for (let i = 0; i < 2; i++) {
    const sign = i === 0 ? -1 : 1,
      outline = points.outline?.[i === 0 ? "left" : "right"];
    const side = body.sides[i],
      path = armPath(points, photo, body, side, sign);
    const shoulderHalf =
      measured(outline, "shoulder", 0.5, 0.79, 0.589) * shoulderScale;
    const capX = clamp(
      shoulderHalf - 0.095 * shoulderScale,
      0.47 * shoulderScale,
      0.65 * shoulderScale,
    );
    const arcPoint = (x) =>
      add(
        center,
        horizontal,
        sign * x * span,
        vertical,
        (shoulderHeight(outline, x / shoulderScale) - 0.012) * span,
      );
    const cap = arcPoint(capX);
    const neck = arcPoint(neckHalf);

    const hpHalf = (hipSpan / span) * 0.52 + 0.1;
    const chest = measured(
      outline,
      "chest",
      0.38,
      0.83,
      Math.max(0.515, hpHalf * 0.91),
    );
    const waist = measured(
      outline,
      "waist",
      0.33,
      0.88,
      Math.max(0.443, hpHalf * 0.94),
    );
    const pit = section(chestLevel, sign * (chest + 0.018) * torsoScale);
    const waistPt = section(waistLevel, sign * (waist + 0.018) * torsoScale);
    const edgeHemLevel =
      hemLevel -
      clamp(
        (hood.y - a.hem[i].y) / Math.max(0.3, hood.y - a.neck.y),
        -0.09,
        0.15,
      ) *
        (hemLevel + 0.18);
    const hem = section(
      edgeHemLevel,
      sign * (Math.max(waist + 0.01, hpHalf) + 0.018) * torsoScale,
    );
    shoulderEnds.push(cap);
    pits.push(pit);
    hemEnds.push(hem);
    for (const [sourcePoint, targetPoint] of [
      [a.neckSides[i], neck],
      [a.shoulders[i], cap],
    ]) {
      const y = sourceTop(a, sourcePoint.x, sourcePoint.y);
      put({ x: sourcePoint.x, y }, targetPoint);
      put(
        sourcePoint,
        add(
          targetPoint,
          vertical,
          clamp(sourcePoint.y - y, 0, 0.07) * torso * 1.24,
        ),
      );
    }
    for (const f of [0.25, 0.53, 0.79]) {
      const p = mix(a.neckSides[i], a.shoulders[i], f);
      put(
        { x: p.x, y: sourceTop(a, p.x, p.y - 0.013) },
        arcPoint(neckHalf + (capX - neckHalf) * f),
      );
    }
    // The outside cap is lower and further out than the seam at the bony shoulder.
    const sourceCap = add(a.shoulders[i], { x: sign, y: 0 }, 0.043);
    sourceCap.y = sourceTop(a, sourceCap.x, a.shoulders[i].y + 0.035);
    put(sourceCap, arcPoint(capX + 0.075 * shoulderScale));

    put(a.pits[i], pit);
    put(a.hem[i], hem);
    put(mix(a.pits[i], a.hem[i], 0.63), waistPt);
    const xShoulder = a.shoulders[i].x;
    // Top corners are outside the actual neckline. Map them with the collar/shoulder span.
    const neckToCapX = a.neckSides[i].x - xShoulder || 0.18;
    const horizontalScale = (cap.x - neck.x) / -neckToCapX;
    put(
      { x: i, y: 0 },
      {
        x: cap.x + (i - xShoulder) * horizontalScale,
        y: cap.y - a.shoulders[i].y * torso,
      },
    );
    // Map the sleeve seams independently of torso length: cuffs can go at different heights.
    const sourceElbow = a.elbows[i],
      sourceCuff = a.cuffs[i];
    const capWidth = Math.max(
      0.09,
      Math.abs(a.shoulders[i].x - a.pits[i].x) + 0.105,
    );
    const srcElbowWidth = clamp(sourceElbow.width || capWidth, 0.045, 0.39);
    const srcCuffWidth = clamp(
      sourceCuff.width || srcElbowWidth * 0.79,
      0.038,
      0.39,
    );
    const elbowRadius =
      span *
      (measured(outline, "upperArm", 0.065, 0.185, 0.102) + 0.012) *
      Math.sqrt(shoulderScale);
    const wristRadius =
      span *
      (measured(outline, "wrist", 0.031, 0.12, 0.057) + 0.011) *
      Math.sqrt(shoulderScale);
    const cuff = pointAlongArm(path, clamp(0.984 * sleeveScale, 0.14, 1.3));
    const elbow = path.elbow;
    const cuffRadius = wristRadius;
    const sourceOuterElbow = sleeveBoundary(
      sourceElbow,
      a.shoulders[i],
      sourceCuff,
      srcElbowWidth / 2,
      sign,
      ratio,
    );
    const sourceInnerElbow = sleeveBoundary(
      sourceElbow,
      a.shoulders[i],
      sourceCuff,
      -srcElbowWidth / 2,
      sign,
      ratio,
    );
    const outerElbow = targetBoundary(
      elbow,
      path.shoulder,
      cuff,
      elbowRadius,
      sign,
    );
    const innerElbow = targetBoundary(
      elbow,
      path.shoulder,
      cuff,
      -elbowRadius,
      sign,
    );
    const srcOuterCuff = sleeveBoundary(
      sourceCuff,
      sourceElbow,
      sourceCuff,
      srcCuffWidth / 2,
      sign,
      ratio,
    );
    const srcInnerCuff = sleeveBoundary(
      sourceCuff,
      sourceElbow,
      sourceCuff,
      -srcCuffWidth / 2,
      sign,
      ratio,
    );
    const outerCuff = targetBoundary(cuff, elbow, cuff, cuffRadius, sign);
    const innerCuff = targetBoundary(cuff, elbow, cuff, -cuffRadius, sign);
    put(sourceElbow, elbow, 1);
    put(sourceCuff, cuff, 1);
    put(sourceOuterElbow, outerElbow, 1);
    put(sourceInnerElbow, innerElbow, 1);
    put(srcOuterCuff, outerCuff, 1);
    put(srcInnerCuff, innerCuff, 1);
    const upperCenter = mix(path.shoulder, elbow, 0.43);
    const upperRadius =
      span *
      (measured(outline, "upperArm", 0.065, 0.19, 0.117) + 0.015) *
      Math.sqrt(shoulderScale);
    // Source has a curved deltoid. Its outer edge needs to reach around, not just to, the arm.
    const sourceUpperOuter = mix(a.shoulders[i], sourceOuterElbow, 0.46);
    const upperOuter = targetBoundary(
      upperCenter,
      path.shoulder,
      elbow,
      upperRadius,
      sign,
    );
    put(sourceUpperOuter, upperOuter, 1);
    const forearmRadius =
      span *
      (measured(outline, "forearm", 0.045, 0.15, 0.081) + 0.008) *
      Math.sqrt(shoulderScale);
    for (const f of [0.22, 0.45, 0.66, 0.82, 0.935]) {
      const p = mix(sourceElbow, sourceCuff, f),
        dest = mix(elbow, cuff, f);
      const radius =
        f < 0.45
          ? elbowRadius + ((forearmRadius - elbowRadius) * f) / 0.45
          : forearmRadius + ((cuffRadius - forearmRadius) * (f - 0.45)) / 0.55;
      const expectedOuter = mix(sourceOuterElbow, srcOuterCuff, f),
        expectedInner = mix(sourceInnerElbow, srcInnerCuff, f);
      const edges = sleeveLimits(a, i, p.y, expectedOuter, expectedInner);
      put(edges.outer, targetBoundary(dest, elbow, cuff, radius, sign), 1);
      put(edges.inner, targetBoundary(dest, elbow, cuff, -radius, sign), 1);
      put(p, dest, 1);
    }
    const tailDir = direction(elbow, cuff);
    const srcForearmHeight = Math.max(0.06, sourceCuff.y - sourceElbow.y);
    const forearmScale = dist(elbow, cuff) / srcForearmHeight;
    const tangent = { x: tailDir.y, y: -tailDir.x };
    const destEnd = add(cuff, tailDir, (1 - sourceCuff.y) * forearmScale);
    // Continue the last segment with its own affine orientation. A square background-corner
    // anchor otherwise flares the transparent margin into a pointed cuff on tight cutouts.
    for (const x of [i, sourceCuff.x, srcInnerCuff.x, srcOuterCuff.x]) {
      put(
        { x, y: 1 },
        add(
          destEnd,
          tangent,
          ((x - sourceCuff.x) * cuffRadius * 2) / srcCuffWidth,
        ),
        1,
      );
    }
  }
  for (const f of [0.09, 0.22, 0.34, 0.66, 0.78, 0.91]) {
    const idx = f < 0.5 ? 0 : 1,
      rad = Math.abs(2 * f - 1);
    const edge = a.hem[idx];
    const x = a.hem[0].x * (1 - f) + a.hem[1].x * f;
    const srcY = typeof a.bottomAt === "function" ? a.bottomAt(x) : null;
    const y = srcY ?? hood.y + (edge.y - hood.y) * rad ** 2.6;
    const dest = mix(section(hemLevel, 0), hemEnds[idx], rad);
    const baseDiff = (hemEnds[idx].y - section(hemLevel, 0).y) * rad;
    dest.y += baseDiff * (rad ** 1.6 - 1);
    put({ x, y }, dest);
  }
  const centerBottom = section(hemLevel + (1 - hood.y) * 1.24, 0);
  put({ x: hood.x, y: 1 }, centerBottom);
  // Triangulation depends on source controls only; sliders and body changes reuse it.
  let topology = topologyCache.get(a);
  if (!topology || topology.ratio !== ratio || topology.n !== vertices.length) {
    const tris = triangulate(vertices, ratio);
    topology = {
      ratio,
      n: vertices.length,
      tris: tris.sort(
        (l, r) =>
          l.reduce((n, i) => n + vertices[i].zone, 0) -
          r.reduce((n, i) => n + vertices[i].zone, 0),
      ),
    };
    topologyCache.set(a, topology);
  }
  return {
    cx: (center.x + body.pelvis.x) * 0.5,
    cy: (center.y + body.pelvis.y) * 0.5,
    vertices,
    triangles: topology.tris,
    frame: photo,
    shoulders: shoulderEnds,
    pits,
    hem: hemEnds,
    span,
    neckOpening: a.neckOpening,
  };
}
// Expand each destination clip very slightly at an interior edge to close rasterizer seams.
// The actual texture transform stays unchanged; the fabric is not drawn with a stroke.
function drawTriangle(ctx, image, rect, vertices, face) {
  const u = face.map((i) => vertices[i].s),
    t = face.map((i) => vertices[i].t);
  const [x, y, w, h] = rect;
  const x0 = x + w * u[0].x,
    y0 = y + h * u[0].y;
  const a = w * (u[1].x - u[0].x),
    b = w * (u[2].x - u[0].x),
    c = h * (u[1].y - u[0].y),
    d = h * (u[2].y - u[0].y);
  const det = a * d - b * c;
  if (Math.abs(det) < 0.004 || Math.abs(cross(...t)) < 0.08) return;
  const v0 = t[0],
    dx1 = t[1].x - v0.x,
    dx2 = t[2].x - v0.x,
    dy1 = t[1].y - v0.y,
    dy2 = t[2].y - v0.y;
  const m00 = (dx1 * d - dx2 * c) / det,
    m01 = (dx2 * a - dx1 * b) / det;
  const m10 = (dy1 * d - dy2 * c) / det,
    m11 = (dy2 * a - dy1 * b) / det;
  const winding = cross(...t) > 0 ? 1 : -1;
  const normals = t.map((p, i) => {
    const u = direction(p, t[(i + 1) % 3]);
    return { x: u.y * winding, y: -u.x * winding };
  });
  ctx.save();
  ctx.beginPath();
  t.forEach((p, i) => {
    const prev = normals[(i + 2) % 3],
      next = normals[i];
    const miter = Math.min(3.5, 0.84 / Math.max(0.02, 1 + dot(prev, next)));
    const q = {
      x: p.x + miter * (prev.x + next.x),
      y: p.y + miter * (prev.y + next.y),
    };
    if (!i) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.closePath();
  ctx.clip();
  ctx.transform(
    m00,
    m10,
    m01,
    m11,
    v0.x - m00 * x0 - m01 * y0,
    v0.y - m10 * x0 - m11 * y0,
  );
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}
const collarCache = new WeakMap();
function openCollar(ctx, image, rect, opening) {
  if (!Array.isArray(opening) || opening.length < 3) return image;
  const key =
    rect.join(",") + "|" + opening.map((p) => p.x + "," + p.y).join(";");
  const prior = collarCache.get(image);
  if (prior?.key === key) return prior.canvas;
  let canvas;
  if (typeof OffscreenCanvas !== "undefined")
    canvas = new OffscreenCanvas(image.width, image.height);
  else if (typeof document !== "undefined")
    canvas = document.createElement("canvas");
  else canvas = new ctx.canvas.constructor(image.width, image.height);
  canvas.width = image.width;
  canvas.height = image.height;
  const g = canvas.getContext("2d");
  if (!g) return image;
  g.drawImage(image, 0, 0);
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  opening.forEach((p, i) => {
    const x = rect[0] + p.x * rect[2],
      y = rect[1] + p.y * rect[3];
    if (!i) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.closePath();
  g.fill();
  collarCache.set(image, { key, canvas });
  return canvas;
}
export function drawUpperMesh(ctx, image, bounds, mesh) {
  if (!mesh) return;
  const fabric = openCollar(ctx, image, bounds, mesh.neckOpening);
  for (const triangle of mesh.triangles)
    drawTriangle(ctx, fabric, bounds, mesh.vertices, triangle);
}
function hull(points) {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const loop = (arr) => {
    const out = [];
    for (const p of arr) {
      while (
        out.length >= 2 &&
        cross(out[out.length - 2], out[out.length - 1], p) <= 0
      )
        out.pop();
      out.push(p);
    }
    return out;
  };
  return [...loop(sorted).slice(0, -1), ...loop(sorted.reverse()).slice(0, -1)];
}
/** Restore observed hands over the garment on crossed-arm poses; never infer outside visible joints. */
export function restoreUpperHands(ctx, base, photo, points, mesh) {
  if (!points || !mesh) return;
  for (const side of [15, 16]) {
    const hand = [side, side + 2, side + 4, side + 6].map((i) =>
      mapJoint(points, i, photo, 0.65),
    );
    if (!hand.every(Boolean)) continue;
    const center = hand.reduce(
      (p, q) => ({ x: p.x + q.x / 4, y: p.y + q.y / 4 }),
      { x: 0, y: 0 },
    );
    if (
      Math.abs(center.x - mesh.cx) > mesh.span * 0.57 ||
      center.y <
        Math.min(...mesh.shoulders.map((p) => p.y)) - 0.1 * mesh.span ||
      center.y > Math.max(...mesh.hem.map((p) => p.y)) + 0.05 * mesh.span
    )
      continue;
    if (
      dist(hand[0], hand[2]) < mesh.span * 0.065 ||
      dist(hand[0], hand[2]) > mesh.span * 0.54
    )
      continue;
    const polygon = hull(hand);
    if (polygon.length < 3) continue;
    ctx.save();
    ctx.beginPath();
    polygon.forEach((p, i) => {
      const q = mix(center, p, 0.97);
      if (!i) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(base, photo.left, photo.top, photo.width, photo.height);
    ctx.restore();
  }
}
