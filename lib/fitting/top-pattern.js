// The flat lay is partitioned once in texture space. A loose cuff beside the
// hem can share the same image row without sharing a single mesh vertex.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, t) => a + (b - a) * t;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const p = (x, y) => ({ x, y });
const rowAt = (shape, y) =>
  shape.rows[Math.round(clamp(y, 0, 1) * (shape.rows.length - 1))];
const centerRun = (r, center) =>
  r.runs.find(([lo, hi]) => lo < center && hi > center);

function inferFromRows(shape) {
  const { rows, description = "" } = shape;
  const middle = rows.slice(
    Math.round(rows.length * 0.28),
    Math.round(rows.length * 0.8),
  );
  const cx = median(middle.map((r) => (r.left + r.right) / 2));
  const width = median(middle.map((r) => r.right - r.left));
  const trunk = rows.map((r) => centerRun(r, cx));
  const bottomIndex = trunk.findLastIndex(Boolean);
  const bottom = clamp(bottomIndex / (rows.length - 1), 0.48, 1);
  const samples = trunk
    .slice(Math.floor(bottomIndex * 0.71), Math.ceil(bottomIndex * 0.97))
    .filter(Boolean);
  samples.sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  const representative = samples[Math.floor(samples.length * 0.28)] || [
    cx - width * 0.32,
    cx + width * 0.32,
  ];
  const namedVest = /\b(vest|sleeveless|tank|camisole|halter)\b/.test(
    description,
  );
  const namedShort =
    /\b(tee|t-shirt|short[- ]sleeve[ds]?|camp shirt|polo)\b/.test(description);
  const maxSpread = Math.max(...middle.map((r) => r.right - r.left));
  const growsDown =
    rowAt(shape, 0.7).right - rowAt(shape, 0.7).left > maxSpread * 0.95;
  const noSleeve =
    namedVest ||
    (!namedShort &&
      !growsDown &&
      maxSpread - (representative[1] - representative[0]) < 0.068);
  // If a sleeve touches the chest all the way to the hem, the center run
  // includes both. Estimate the seam from the shoulder crown in that case.
  const joined =
    growsDown &&
    !noSleeve &&
    representative[1] - representative[0] > 0.77 * maxSpread;
  const sides = joined
    ? [cx - 0.3 * maxSpread, cx + 0.3 * maxSpread]
    : representative;
  const shoulders = [],
    pits = [],
    cuffs = [],
    elbows = [],
    hem = [];
  for (const side of [0, 1]) {
    const sign = side ? 1 : -1;
    const sx = noSleeve
      ? mix(cx, sides[side], 0.78)
      : sides[side] + sign * 0.026;
    const capIndex = rows.findIndex((r) =>
      r.runs.some(([lo, hi]) => lo <= sx && hi >= sx),
    );
    const capY = clamp(capIndex / (rows.length - 1), 0.035, 0.27);
    const pitY = clamp(capY + 0.23 * bottom, 0.23, 0.46);
    let last = pitY;
    rows.forEach((r, i) => {
      const y = i / (rows.length - 1);
      if (y < capY) return;
      const outside = side ? r.right : r.left;
      if ((outside - sides[side]) * sign > 0.067 * maxSpread) {
        last = y;
      }
    });
    const cuffRow = rowAt(shape, last - 0.018);
    const cuffX =
      (side ? cuffRow.right : cuffRow.left) - sign * 0.058 * maxSpread;
    shoulders.push(p(sx, capY));
    pits.push(p(sides[side], pitY));
    cuffs.push(p(cuffX, last));
    elbows.push(p(mix(sx, cuffX, 0.53), mix(capY, last, 0.53)));
    const hemX = sides[side];
    const sideBottom = rows.findLastIndex((r) => {
      const run = centerRun(r, cx);
      return run && hemX >= run[0] - 0.008 && hemX <= run[1] + 0.008;
    });
    hem.push(
      p(hemX, clamp(sideBottom / (rows.length - 1), bottom - 0.14, bottom)),
    );
  }
  const sleeveLength = noSleeve
    ? "sleeveless"
    : namedShort || Math.max(...cuffs.map((c) => c.y)) < 0.68 * bottom
      ? "short"
      : "long";
  return {
    neck: p(cx, 0),
    shoulders,
    pits,
    cuffs,
    elbows,
    hem,
    hemCenter: p(cx, bottom),
    sleeveLength,
  };
}

function seamAt(a, side, y) {
  const cap = a.shoulders[side],
    pit = a.pits[side],
    hem = a.hem[side];
  if (y < cap.y) return cap.x;
  if (y <= pit.y)
    return mix(cap.x, pit.x, (y - cap.y) / Math.max(0.03, pit.y - cap.y));
  return mix(
    pit.x,
    hem.x,
    clamp((y - pit.y) / Math.max(0.04, hem.y - pit.y), 0, 1),
  );
}

function sideAt(shape, a, side, y, center, length) {
  const row = rowAt(shape, y);
  const sign = side ? 1 : -1;
  const expected = seamAt(a, side, y);
  const main = centerRun(row, center);
  const outer = side ? row.right : row.left;
  if (length === "sleeveless") {
    const seam = (outer - expected) * sign > 0 ? outer : expected;
    return { seam, inner: seam, outer: seam };
  }
  const observed = a.edgeAt?.(side, y);
  const split = row.runs.find(
    (run) =>
      (run[1 - side] - expected) * sign > -0.085 &&
      (run[side] - expected) * sign > 0.025 &&
      run !== main,
  );
  let seam = expected;
  if (
    main &&
    (split || observed) &&
    Math.abs(main[side] - expected) < 0.09 &&
    y > a.pits[side].y
  )
    seam = main[side];
  const inner = split?.[1 - side] ?? observed?.inner.x ?? seam;
  return {
    seam,
    inner: (inner - seam) * sign >= -0.008 ? inner : seam,
    outer: split?.[side] ?? observed?.outer.x ?? outer,
  };
}

// A flat lay photographed with sleeves extended sideways has a vertical cuff.
// Cut that sleeve in columns so its cuff stays across the arm after bending.
function sidewaysSleeve(shape, a, side, length) {
  const cap = a.shoulders[side],
    cuff = a.cuffs[side],
    sign = side ? 1 : -1;
  if (
    (cuff.x - cap.x) * sign * shape.aspect <
    1.3 * Math.max(0.055, cuff.y - cap.y)
  )
    return null;
  const edges = shape.rows.map((row, i) => {
    const y = i / (shape.rows.length - 1);
    if (y > Math.max(cuff.y, a.pits[side].y) + 0.19) return null;
    const section = sideAt(shape, a, side, y, a.neck.x, length);
    if ((section.outer - section.inner) * sign < 0.004) return null;
    return section;
  });
  const outside = edges.filter(Boolean).map((e) => e.outer);
  if (!outside.length) return null;
  const end = side ? Math.max(...outside) : Math.min(...outside);
  if ((end - cap.x) * sign < 0.05) return null;
  const rings = [];
  for (let k = 0; k <= 24; k++) {
    const t = k / 24,
      x = mix(cap.x, end, t);
    const hits = [];
    for (let j = 0; j < edges.length; j++) {
      const e = edges[j];
      if (e && (x - e.inner) * sign >= -0.006 && (e.outer - x) * sign >= -0.006)
        hits.push(j / (edges.length - 1));
    }
    if (hits.length < 2) continue;
    rings.push({ t, lower: p(x, hits.at(-1)), upper: p(x, hits[0]) });
  }
  return rings.length >= 5 ? rings : null;
}

export function mapTop(shape, anatomy) {
  if (!shape?.rows?.length || shape.category !== "top") return null;
  const inferred = inferFromRows(shape);
  let a = anatomy || inferred;
  if (
    anatomy &&
    inferred.sleeveLength !== anatomy.sleeveLength &&
    /\b(vest|sleeveless|tank|camisole|halter|tee|t-shirt|short[- ]sleeve[ds]?)\b/.test(
      shape.description || "",
    )
  ) {
    a = inferred;
  }
  const center = a.neck.x;
  const sleeveLength = a.sleeveLength;
  const long = sleeveLength === "long";
  const hemCenterY = a.hemCenter.y;
  const cuffMean = (a.cuffs[0].y + a.cuffs[1].y) / 2;
  const name = shape.description || "";
  const capY = (a.shoulders[0].y + a.shoulders[1].y) / 2;
  const sideData = [0, 1].map((side) => {
    const rings = [];
    const cap = a.shoulders[side],
      pit = a.pits[side],
      cuff = a.cuffs[side];
    if (sleeveLength !== "sleeveless") {
      const sideways = sidewaysSleeve(shape, a, side, sleeveLength);
      if (sideways) return { cap, pit, cuff, rings: sideways, sideways: true };
      const from = Math.max(0, cap.y - 0.045);
      // The measured cuff is the center of its opening; include the cloth
      // through its final opaque row, while never sampling the central skirt.
      const end = Math.min(1, cuff.y + (long ? 0.026 : 0.025));
      const count = Math.max(9, Math.round((end - from) * 36));
      for (let k = 0; k <= count; k++) {
        const y = mix(from, end, k / count);
        const r = sideAt(shape, a, side, y, center, sleeveLength);
        const width = (r.outer - r.inner) * (side ? 1 : -1);
        if (width < 0.009 && k > count / 2) break;
        rings.push({ y, inner: r.inner, outer: width > 0 ? r.outer : r.inner });
      }
    }
    return { cap, pit, cuff, rings };
  });
  const end = /\b(crop|cropped)\b/.test(name)
    ? 0.79
    : long && !sideData.some((side) => side.sideways)
      ? clamp(1.07 + (hemCenterY - cuffMean) * 1.18, 0.64, 1.2)
      : 1.07;
  const wide = a.pits[1].x - a.pits[0].x;
  const flare = clamp((a.hem[1].x - a.hem[0].x) / wide, 0.83, 1.17);
  // Sample the actual shirt-tail column by column. Bounding the lookup
  // rejects pixels of a separate sleeve lying below a cropped jacket.
  const columns = Array.from({ length: 13 }, (_, i) => {
    const q = (i - 6) / 6,
      side = q < 0 ? 0 : 1,
      u = Math.abs(q);
    const hem = a.hem[side],
      x = mix(center, hem.x, u);
    const planned = mix(hemCenterY, hem.y, Math.pow(u, 2.25));
    const observed = a.bottomAt?.(x);
    const bottom =
      u === 1
        ? hem.y
        : Number.isFinite(observed) && Math.abs(observed - planned) < 0.065
          ? observed
          : planned;
    const vEnd =
      end + ((bottom - hemCenterY) * (end + 0.2)) / Math.max(0.35, hemCenterY);
    const { cap, pit } = sideData[side];
    // On a crop top, the waist control remains inside the piece of cloth.
    const waistV = Math.min(0.7, 0.79 * vEnd);
    const waistY = mix(
      pit.y,
      bottom,
      clamp((waistV - 0.23) / Math.max(0.1, vEnd - 0.23), 0.2, 0.83),
    );
    const upperX = mix(center, cap.x, u);
    const topY =
      a.topAt?.(upperX) ??
      shape.rows.findIndex((row) =>
        row.runs.some(([lo, hi]) => upperX >= lo && upperX <= hi),
      ) /
        (shape.rows.length - 1);
    return { q, side, u, cap, pit, bottom, vEnd, waistV, waistY, topY };
  });
  const levels = [0, 0.5, 1, 1.5, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4];
  const rows = levels.map((level) =>
    columns.map((c) => {
      const part = Math.min(3, Math.floor(level)),
        t = level - part;
      const ys = [0, capY, c.pit.y, c.waistY, c.bottom];
      const y = mix(ys[part], ys[part + 1], t);
      const section = sideAt(shape, a, c.side, y, center, sleeveLength);
      return { s: p(mix(center, section.seam, c.u), y), part, t };
    }),
  );
  return {
    a,
    center,
    columns,
    rows,
    sideData,
    flare,
    end,
    sleeveLength,
    aspect: shape.aspect,
  };
}
