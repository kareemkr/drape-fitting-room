// All points use the tight garment rectangle as their coordinate system.
// Each pair is in image-left, image-right order, irrespective of the wearer.
const point = (x, y, width) =>
  width === undefined ? { x, y } : { x, y, width };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const median = (values) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const two = (pairs) => pairs.map((args) => point(...args));

// Measured on the studio's actual transparent source pixels. The shirt has
// a curved shirt-tail, and the cropped jackets end far above their cuffs.
const measured = {
  shirt: {
    neck: [0.504, 0.004],
    neckSides: [
      [0.397, 0.032],
      [0.602, 0.032],
    ],
    shoulders: [
      [0.186, 0.13],
      [0.822, 0.13],
    ],
    pits: [
      [0.25, 0.346],
      [0.754, 0.346],
    ],
    elbows: [
      [0.135, 0.552, 0.18],
      [0.865, 0.552, 0.18],
    ],
    cuffs: [
      [0.067, 0.961, 0.123],
      [0.934, 0.961, 0.123],
    ],
    hem: [
      [0.205, 0.906],
      [0.795, 0.906],
    ],
    hemCenter: [0.5, 0.994],
  },
  knit: {
    neck: [0.51, 0.006],
    neckSides: [
      [0.378, 0.032],
      [0.643, 0.032],
    ],
    shoulders: [
      [0.168, 0.094],
      [0.846, 0.094],
    ],
    pits: [
      [0.251, 0.381],
      [0.767, 0.381],
    ],
    elbows: [
      [0.131, 0.555, 0.179],
      [0.877, 0.555, 0.179],
    ],
    cuffs: [
      [0.06, 0.985, 0.111],
      [0.924, 0.985, 0.115],
    ],
    hem: [
      [0.205, 0.833],
      [0.8, 0.833],
    ],
    hemCenter: [0.504, 0.85],
  },
  denim: {
    neck: [0.5, 0.005],
    neckSides: [
      [0.397, 0.038],
      [0.601, 0.038],
    ],
    shoulders: [
      [0.167, 0.13],
      [0.831, 0.13],
    ],
    pits: [
      [0.218, 0.388],
      [0.784, 0.388],
    ],
    elbows: [
      [0.134, 0.555, 0.184],
      [0.871, 0.555, 0.187],
    ],
    cuffs: [
      [0.09, 0.981, 0.145],
      [0.918, 0.981, 0.143],
    ],
    hem: [
      [0.211, 0.818],
      [0.788, 0.818],
    ],
    hemCenter: [0.5, 0.87],
  },
  leather: {
    neck: [0.509, 0.005],
    neckSides: [
      [0.403, 0.036],
      [0.618, 0.036],
    ],
    shoulders: [
      [0.174, 0.128],
      [0.838, 0.129],
    ],
    pits: [
      [0.241, 0.362],
      [0.777, 0.365],
    ],
    elbows: [
      [0.134, 0.536, 0.182],
      [0.877, 0.538, 0.183],
    ],
    cuffs: [
      [0.08, 0.965, 0.142],
      [0.916, 0.966, 0.145],
    ],
    hem: [
      [0.23, 0.692],
      [0.774, 0.691],
    ],
    hemCenter: [0.509, 0.715],
  },
};

// Calibrated openings follow the inside front collar seam in the four studio
// photos. Removing the flatlay's back panel lets the real neck show through.
const collarOpenings = {
  shirt: [
    [0.408, -0.008],
    [0.595, -0.008],
    [0.6, 0.013],
    [0.598, 0.039],
    [0.591, 0.057],
    [0.58, 0.08],
    [0.564, 0.096],
    [0.539, 0.102],
    [0.516, 0.113],
    [0.506, 0.123],
    [0.496, 0.114],
    [0.474, 0.105],
    [0.45, 0.099],
    [0.435, 0.091],
    [0.417, 0.066],
    [0.409, 0.046],
    [0.405, 0.019],
  ],
  knit: [
    [0.383, -0.008],
    [0.641, -0.008],
    [0.643, 0.012],
    [0.637, 0.034],
    [0.627, 0.046],
    [0.61, 0.06],
    [0.588, 0.072],
    [0.562, 0.078],
    [0.538, 0.081],
    [0.51, 0.082],
    [0.477, 0.08],
    [0.449, 0.074],
    [0.425, 0.065],
    [0.405, 0.052],
    [0.391, 0.035],
    [0.384, 0.017],
  ],
  leather: [
    [0.418, -0.008],
    [0.604, -0.008],
    [0.612, 0.012],
    [0.612, 0.038],
    [0.605, 0.058],
    [0.591, 0.09],
    [0.577, 0.125],
    [0.56, 0.156],
    [0.535, 0.192],
    [0.514, 0.17],
    [0.488, 0.149],
    [0.459, 0.128],
    [0.448, 0.106],
    [0.428, 0.073],
    [0.419, 0.05],
    [0.412, 0.026],
  ],
  denim: [
    [0.413, -0.008],
    [0.595, -0.008],
    [0.597, 0.008],
    [0.603, 0.035],
    [0.603, 0.095],
    [0.602, 0.128],
    [0.598, 0.145],
    [0.581, 0.154],
    [0.564, 0.17],
    [0.552, 0.194],
    [0.544, 0.219],
    [0.538, 0.236],
    [0.494, 0.236],
    [0.484, 0.217],
    [0.477, 0.193],
    [0.459, 0.17],
    [0.434, 0.15],
    [0.418, 0.14],
    [0.41, 0.117],
    [0.407, 0.073],
    [0.408, 0.034],
  ],
};

// 65 samples across each tight cutout. Six hex-byte curves encode upper and
// lower silhouettes, then left and right sleeve intervals; ff marks no edge.
// Keeping these with the photo annotations also permits shape-only testing.
const catalogContours = {
  shirt: [
    "ffaa998677645646382b24201d1b19181615141211100f0d09050100000000000000000000000104080c0f10111214151718191b1c1f232a37445463758597a9ee",
    "fff1f1f2f2f2f3f3f3e6d6c8bae3e9edf0f2f5f6f7f7f8f9f9f9fafafafafafaf9fafafafafafafafaf9f9f8f7f6f5f2f0ede8e2bbcad7e5f3f3f3f3f2f2f1f1f0",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0606050404030202020202030304040403030201010dffff",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff373635333231302f2e2c2b2a28272625242423222221ffff",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3c4c6c7c8c9cacbcccdcfd0d1d2d3d5d6d6d7d8d9daffff",
    "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff4f4f5f6f6f7f7f8f8f8f7f7f7f7f6f6f7f8f8f9faefffff",
  ],
  knit: [
    "ffbb987f63503d2d241c1916141211100e0d0c0b09080503010000010203030303030303030202010000020507090b0c0d0e1011121315171c202a394f6e89b6ff",
    "fff9fafafafafafaf5e1d3c5b2d2d2d3d4d4d4d4d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d4d4d4d3d2b0c3d5e3f8f9f9f9f9f9f9e3ff",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffff0f0e0d0d0c0c0b0b0a0a09080807070606050504040303030202010101010304040303030c",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffff3d3d3c3b3b3a39383736363534333231302f2f2e2d2c2b2a292827272624222020201f1f1a",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffbfc0c0c1c1c2c3c3c4c5c5c6c7c8c9cacacbcccdcecfd0d1d2d2d3d3d4d6d7d8d8d9d9d9ff",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffeeefeff0f0f0f1f2f2f3f3f4f4f4f5f5f5f5f6f6f7f7f7f7f8f8f9f9f9f8f6f5f5f6f6f6ff",
  ],
  denim: [
    "c8a18e7e6b5b4a3d322822201e1d1b1a1817151513120f0c08050100000000000000000000000103080b0e1213141617181a1b1c1e202227303b4b5b6a7b8da6ca",
    "cef7f8f9f9fafafafafaf8d5bdcdd0d2d3d3d5d5d6d6d7d8d8d8d9dadac9c9c9c9c9c9c9c9d0dadad9d8d8d7d6d6d5d4d3d2d0cec3d7f0f9f9f9f9f9f9f8f7f7cf",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0606050504040303030202010101000101020203040303040404ff",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff363534343433323130302f2e2d2d2c2b2b2a2a29292829282827ff",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc4c5c5c6c6ffffc8c9cacbcccdcdcecfcfd0d1d1d2d2d3d3d3ff",
    "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff4f5f5f5f6fffff7f7f8f8f9f9faf9f9f9f8f8f7f7f7f7f7f7ff",
  ],
  leather: [
    "ffa7967c655142372d27231e1c1b1a1a1817161515120f0c0905020000000000000000000000000104080b0e111515161718191a1b1c1e23282f3945586d89a0f2",
    "fffaf5f5f5f5f5f5f5f5e3c4ab9587aeafafb0b1b1b2b2b3b3b3b3b3b3b3b4b4b4b4b4b3b3b4b3b3b3b3b2b2b1b1b0b0afaead91a8c6e9f5f5f5f5f5f5f5f5faf3",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffff0e0e0c0c0b0b0a0a090909070606050404040303020202020201010101010101010101ffff",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffff3c3b3a3939383736353433323130302f2e2e2d2c2c2b2b2a2a29292828272727262626ffff",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc1c1c2c3c4c4c5c6c7c8c9c9cacbcbcccdcdcececfcfd0d0d1d1d1d2d2d2d3d3d3d4ffff",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeff0f0f1f1f2f2f2f3f4f5f5f5f6f7f7f7f8f8f8f8f9f9f9f9f9f9f9f9f9f9f9f9faffff",
  ],
};

function unpackCurves(id) {
  return catalogContours[id].map((row) =>
    Array.from({ length: row.length / 2 }, (_, i) => {
      const value = parseInt(row.slice(i * 2, i * 2 + 2), 16);
      return value === 255 ? null : value / 250;
    }),
  );
}

function contourProfile(frame) {
  const { width, height, data } = frame;
  const tables = Array.from({ length: 6 }, () => []);
  for (let i = 0; i <= 64; i++) {
    const x = Math.round(((width - 1) * i) / 64),
      y = Math.round(((height - 1) * i) / 64);
    let top = null,
      bottom = null,
      begin = -1,
      spans = [];
    for (let v = 0; v < height; v++)
      if (data[(v * width + x) * 4 + 3] >= 80) {
        if (top === null) top = v / (height - 1);
        bottom = v / (height - 1);
      }
    for (let u = 0; u <= width; u++) {
      const filled = u < width && data[(y * width + u) * 4 + 3] >= 80;
      if (filled && begin < 0) begin = u;
      if (!filled && begin >= 0) {
        if (u - begin >= 0.035 * width)
          spans.push([begin / (width - 1), (u - 1) / (width - 1)]);
        begin = -1;
      }
    }
    tables[0].push(top);
    tables[1].push(bottom);
    const left = spans[0],
      right = spans[spans.length - 1];
    tables[2].push(left && left[1] < 0.305 ? left[0] : null);
    tables[3].push(left && left[1] < 0.305 ? left[1] : null);
    tables[4].push(right && right[0] > 0.695 ? right[0] : null);
    tables[5].push(right && right[0] > 0.695 ? right[1] : null);
  }
  return tables;
}

function attachContours(profile, tables) {
  function sample(curve, pos) {
    if (!Number.isFinite(pos) || pos < 0 || pos > 1) return null;
    const at = pos * (curve.length - 1),
      before = Math.floor(at),
      after = Math.ceil(at);
    const a = curve[before],
      b = curve[after];
    if (a == null || b == null) return null;
    return a + (b - a) * (at - before);
  }
  return Object.assign(profile, {
    topAt(x) {
      return sample(tables[0], x);
    },
    bottomAt(x) {
      return x < profile.hem[0].x || x > profile.hem[1].x
        ? null
        : sample(tables[1], x);
    },
    edgeAt(sideIndex, y) {
      if (sideIndex !== 0 && sideIndex !== 1) return null;
      const left = sample(tables[2 + sideIndex * 2], y),
        right = sample(tables[3 + sideIndex * 2], y);
      if (left === null || right === null) return null;
      return {
        outer: point(sideIndex === 0 ? left : right, y),
        inner: point(sideIndex === 0 ? right : left, y),
      };
    },
  });
}

function studioProfile(item) {
  return {
    neck: point(...item.neck),
    neckSides: two(item.neckSides),
    shoulders: two(item.shoulders),
    pits: two(item.pits),
    hem: two(item.hem),
    hemCenter: point(...item.hemCenter),
    elbows: two(item.elbows),
    cuffs: two(item.cuffs),
    sleeveLength: "long",
    confidence: 1,
  };
}

const GRID = 112;
function normalizedMask(frame) {
  const { width, height, data } = frame;
  if (
    width < 18 ||
    height < 20 ||
    width / height < 0.32 ||
    width / height > 3.1
  )
    return null;
  const mask = new Uint8Array(GRID * GRID);
  let opaque = 0,
    mirrored = 0,
    centerCount = 0;
  for (let y = 0; y < GRID; ++y) {
    const py = Math.min(height - 1, Math.floor(((y + 0.5) * height) / GRID));
    for (let x = 0; x < GRID; ++x) {
      const px = Math.min(width - 1, Math.floor(((x + 0.5) * width) / GRID));
      const alpha = data[(py * width + px) * 4 + 3];
      mask[y * GRID + x] = alpha >= 110 ? 1 : 0;
      opaque += mask[y * GRID + x];
      if (
        x > GRID * 0.32 &&
        x < GRID * 0.68 &&
        y > GRID * 0.2 &&
        y < GRID * 0.62
      )
        centerCount += mask[y * GRID + x];
    }
  }
  const coverage = opaque / mask.length;
  if (
    coverage < 0.17 ||
    coverage > 0.966 ||
    centerCount < GRID * GRID * 0.36 * 0.42 * 0.63
  )
    return null;
  for (let y = 0; y < GRID; ++y) {
    for (let x = 0; x < GRID; ++x)
      if (mask[y * GRID + x] && mask[y * GRID + GRID - 1 - x]) mirrored++;
  }
  const symmetry = mirrored / opaque;
  if (symmetry < 0.72) return null;
  return { mask, symmetry };
}

function runsInRow(mask, y) {
  const index = clamp(Math.round(y * (GRID - 1)), 0, GRID - 1) * GRID;
  const runs = [];
  let begin = -1;
  for (let x = 0; x <= GRID; ++x) {
    const on = x < GRID && mask[index + x];
    if (on && begin < 0) begin = x;
    if (!on && begin >= 0) {
      if (x - begin >= 2) runs.push([begin / GRID, x / GRID]);
      begin = -1;
    }
  }
  return runs;
}

function columnExtent(mask, x, top) {
  const col = clamp(Math.floor(x * GRID), 0, GRID - 1);
  for (let i = 0; i < GRID; i++) {
    const row = top ? i : GRID - 1 - i;
    if (mask[row * GRID + col]) return (row + 0.5) / GRID;
  }
  return NaN;
}

function outerEdge(runs) {
  return runs.length ? [runs[0][0], runs[runs.length - 1][1]] : null;
}

function coreAt(mask, y) {
  const runs = runsInRow(mask, y);
  const body = runs.filter(([l, r]) => r > 0.31 && l < 0.69);
  return outerEdge(body);
}

function projectSleeve(mask, side, shoulder, torsoEdge, aspect, armpit) {
  // Find the cuff independently on each side. Distances use original image
  // proportions so horizontally laid sleeves are measured along their axis.
  const lateral = [];
  let longest = 0;
  for (let y = Math.floor(shoulder.y * GRID); y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!mask[y * GRID + x]) continue;
      const gx = (x + 0.5) / GRID,
        gy = (y + 0.5) / GRID;
      if (side * (gx - torsoEdge) < 0.015) continue;
      const vx = (gx - shoulder.x) * aspect,
        vy = gy - shoulder.y;
      const d = Math.hypot(vx, vy);
      lateral.push({ gx, gy, d });
      longest = Math.max(longest, d);
    }
  }
  if (lateral.length < 35 || longest < 0.12) return null;
  const furthest = lateral.filter((p) => p.d > longest * 0.925);
  const fx = median(furthest.map((p) => p.gx)),
    fy = median(furthest.map((p) => p.gy));
  const vx = (fx - shoulder.x) * aspect,
    vy = fy - shoulder.y;
  const len = Math.hypot(vx, vy);
  if (!len) return null;
  const ux = vx / len,
    uy = vy / len;
  function section(t, margin) {
    const cross = [];
    for (const { gx, gy } of lateral) {
      const dx = (gx - shoulder.x) * aspect,
        dy = gy - shoulder.y;
      if (Math.abs(dx * ux + dy * uy - t) < margin)
        cross.push(-dx * uy + dy * ux);
    }
    if (cross.length < 2) return null;
    const lo = Math.min(...cross),
      hi = Math.max(...cross),
      mid = (lo + hi) / 2;
    return point(
      clamp(shoulder.x + (t * ux - mid * uy) / aspect, 0, 1),
      clamp(shoulder.y + t * uy + mid * ux, 0, 1),
      clamp((hi - lo) / aspect, 0.055, 0.32),
    );
  }
  const end = section(len - 0.018, 0.019) || point(fx, fy, 0.13);
  const elbow =
    section(len * 0.54, 0.023) ||
    point((shoulder.x + end.x) / 2, (shoulder.y + end.y) / 2, end.width * 1.15);
  // With a body and sleeve touching at the elbow, lateral masking clips the
  // inner half of the sleeve. Interpolate from the cap and cuff in that case.
  if (elbow.width < end.width * 0.78) {
    elbow.x = (0.46 * (shoulder.x + armpit.x)) / 2 + 0.54 * end.x;
    elbow.width = Math.min(0.31, end.width * 1.2);
  }
  return { cuff: end, elbow, length: len };
}

function inferProfile(frame) {
  const sampled = normalizedMask(frame);
  if (!sampled) return null;
  const { mask, symmetry } = sampled;
  const centerColumns = [0.33, 0.38, 0.42, 0.48, 0.52, 0.57, 0.62, 0.67];
  const hemDepth = median(
    centerColumns
      .map((x) => columnExtent(mask, x, false))
      .filter(Number.isFinite),
  );
  if (!Number.isFinite(hemDepth) || hemDepth < 0.49) return null;
  const crown = outerEdge(runsInRow(mask, 0.045)),
    upper = outerEdge(runsInRow(mask, 0.225));
  if (!crown || !upper) return null;
  const crownWidth = crown[1] - crown[0],
    upperWidth = upper[1] - upper[0];
  // A straight-sided rectangle, head above a body, or opaque lifestyle
  // product image cannot establish a garment collar and shoulder line.
  if (
    crownWidth > 0.75 ||
    crownWidth < 0.1 ||
    upperWidth < 0.49 ||
    upperWidth < crownWidth + 0.1
  )
    return null;
  const neckX = (crown[0] + crown[1]) / 2;
  if (Math.abs(neckX - 0.5) > 0.15) return null;
  const seams = [];
  for (let u = 0.65; u < 0.975; u += 0.023) {
    const edges = coreAt(mask, u * hemDepth);
    if (edges && edges[1] - edges[0] > 0.23)
      seams.push({ edges, width: edges[1] - edges[0] });
  }
  if (!seams.length) return null;
  seams.sort((a, b) => a.width - b.width);
  // The separated lower torso is narrower than a connected torso+arms run.
  // Ignore the very last taper of a curved hem and use several supporting rows.
  const narrow = seams.slice(0, Math.max(3, Math.floor(seams.length * 0.56)));
  const torsoEdges = [0, 1].map((i) => median(narrow.map((q) => q.edges[i])));
  if (torsoEdges[1] - torsoEdges[0] < 0.25) return null;
  const neckHalf = clamp(crownWidth * 0.42, 0.067, 0.14);
  const result = {
    neck: point(
      neckX,
      clamp(columnExtent(mask, neckX, true) || 0, 0.004, 0.12),
    ),
    neckSides: [point(neckX - neckHalf, 0.04), point(neckX + neckHalf, 0.04)],
    shoulders: [],
    pits: [],
    hem: [],
    elbows: [],
    cuffs: [],
    hemCenter: point(neckX, hemDepth),
    confidence: clamp(0.44 + 0.46 * symmetry, 0.61, 0.9),
  };
  const lengths = [];
  let shortOrNo = 0;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const edge = torsoEdges[i];
    const extension = side === -1 ? edge : 1 - edge;
    const outer = clamp(edge + side * 0.032, 0.08, 0.92);
    const shoulderY = median(
      [-0.012, 0, 0.012]
        .map((d) => columnExtent(mask, clamp(outer + d, 0, 1), true))
        .filter(Number.isFinite),
    );
    if (!Number.isFinite(shoulderY) || shoulderY > 0.39) return null;
    const shoulder = point(outer, shoulderY + 0.012);
    const pit = point(
      edge - side * 0.015,
      clamp(shoulder.y + hemDepth * 0.241, 0.24, 0.475),
    );
    const hemX = edge - side * 0.013;
    const hemY = median(
      [0, 0.015, 0.03]
        .map((d) => columnExtent(mask, hemX - side * d, false))
        .filter(Number.isFinite),
    );
    const hem = point(
      hemX,
      clamp(
        Number.isFinite(hemY) ? hemY : hemDepth,
        hemDepth - 0.16,
        hemDepth + 0.035,
      ),
    );
    const path =
      extension > 0.065
        ? projectSleeve(
            mask,
            side,
            shoulder,
            edge,
            frame.width / frame.height,
            pit,
          )
        : null;
    result.shoulders.push(shoulder);
    result.pits.push(pit);
    result.hem.push(hem);
    if (path) {
      lengths.push(path.length);
      result.elbows.push(path.elbow);
      result.cuffs.push(path.cuff);
    } else {
      shortOrNo++;
      lengths.push(0);
      result.elbows.push({ ...pit, width: 0.07 });
      result.cuffs.push({ ...pit, width: 0.07 });
    }
  }
  if (shortOrNo === 1 || Math.abs(lengths[0] - lengths[1]) > hemDepth * 0.3)
    return null;
  const relativeLength = (lengths[0] + lengths[1]) / (2 * hemDepth);
  result.sleeveLength =
    shortOrNo === 2 ? "sleeveless" : relativeLength > 0.63 ? "long" : "short";
  if (
    result.sleeveLength === "sleeveless" &&
    torsoEdges[1] - torsoEdges[0] > 0.91
  ) {
    result.shoulders.forEach((p, i) => {
      const x = neckX + (i === 0 ? -1 : 1) * 0.265;
      p.x = x;
      p.y = clamp(columnExtent(mask, x, true), 0.02, 0.2);
      result.pits[i].x = i === 0 ? 0.045 : 0.955;
    });
  }
  return result;
}

/** Return null if the cutout does not have a credible front-view upper garment silhouette. */
export function getGarmentAnatomy(canvas, bounds, { id } = {}) {
  if (Object.hasOwn(measured, id)) {
    const catalogProfile = studioProfile(measured[id]);
    catalogProfile.neckOpening = two(collarOpenings[id]);
    return attachContours(catalogProfile, unpackCurves(id));
  }
  if (!canvas || !Array.isArray(bounds) || bounds.length !== 4) return null;
  const [x, y, w, h] = bounds.map(Math.round);
  if (w < 18 || h < 20 || x < 0 || y < 0) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    const frame = ctx.getImageData(x, y, w, h);
    const profile = inferProfile(frame);
    return profile ? attachContours(profile, contourProfile(frame)) : null;
  } catch {
    return null;
  }
}
