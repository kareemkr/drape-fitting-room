import { landmarkAt } from "./live-fullbody.js";

const limit = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
const ease = (lo, hi, x) => {
  const t = limit((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

// The sampler extracts just one number. Colors, prints, and edges from the
// wearer's existing clothes never become texture in the replacement garment.
export function estimateLightDirection(image, sampleAt) {
  const differences = [];
  const { data, width, height } = image;
  function colorAt(x, y) {
    const p = sampleAt(x, y);
    if (!p || p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return null;
    const offset = (Math.floor(p.y) * width + Math.floor(p.x)) * 4;
    const [r, g, b, a] = data.subarray(offset, offset + 4);
    const sum = r + g + b;
    if (a < 224 || sum < 60 || sum > 738) return null;
    return { y: 0.213 * r + 0.715 * g + 0.072 * b, r: r / sum, b: b / sum };
  }
  for (const y of [0.24, 0.34, 0.44, 0.54, 0.64, 0.74]) {
    const center = colorAt(0, y);
    if (!center) continue;
    for (const distance of [0.16, 0.24, 0.32]) {
      const left = colorAt(-distance, y),
        right = colorAt(distance, y);
      if (!left || !right) continue;
      const luma = (left.y + right.y) / 2;
      // Reject abrupt albedo changes, colored panels and isolated highlights.
      if (
        Math.abs(left.r - right.r) + Math.abs(left.b - right.b) > 0.1 ||
        Math.abs(center.y - luma) > luma * 0.26
      )
        continue;
      const difference = (right.y - left.y) / (right.y + left.y + 12);
      if (Math.abs(difference) <= 0.31) differences.push(difference);
    }
  }
  if (differences.length < 5) return 0;
  const direction = median(differences);
  const scatter = median(
    differences.map((value) => Math.abs(value - direction)),
  );
  return limit(direction * 4, -1, 1) * (1 - ease(0.035, 0.13, scatter));
}

function canvas2D(width, height, read = false) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d", { willReadFrequently: read });
}

function measure(sampler, source, body, arms) {
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  if (!width || !height) return 0;
  const { origin, across, down, frame } = body;
  const project = (u, v) => ({
    x: origin.x + across.x * u + down.x * v,
    y: origin.y + across.y * u + down.y * v,
  });
  const corners = [
    project(-0.38, 0.18),
    project(0.38, 0.18),
    project(-0.38, 0.8),
    project(0.38, 0.8),
  ];
  const left = Math.floor(Math.min(...corners.map((p) => p.x)));
  const top = Math.floor(Math.min(...corners.map((p) => p.y)));
  const w = Math.max(...corners.map((p) => p.x)) - left;
  const h = Math.max(...corners.map((p) => p.y)) - top;
  const { width: sw, height: sh } = sampler.canvas;
  sampler.clearRect(0, 0, sw, sh);
  sampler.drawImage(
    source,
    (left * width) / frame.width,
    (top * height) / frame.height,
    (w * width) / frame.width,
    (h * height) / frame.height,
    0,
    0,
    sw,
    sh,
  );
  const pixels = sampler.getImageData(0, 0, sw, sh);
  return estimateLightDirection(pixels, (u, v) => {
    const p = project(u, v);
    for (const arm of arms) {
      // Ignore a forearm or hand crossing this sample even on a baggy sleeve.
      const t = limit(
        ((p.x - arm.start.x) * arm.dx + (p.y - arm.start.y) * arm.dy) /
          arm.length2,
        0,
        1.26,
      );
      if (
        Math.hypot(
          p.x - arm.start.x - t * arm.dx,
          p.y - arm.start.y - t * arm.dy,
        ) <
        body.span * 0.16
      )
        return null;
    }
    return { x: ((p.x - left) * sw) / w, y: ((p.y - top) * sh) / h };
  });
}

// Each tile stores only the alpha of neutral black. Source-atop multiplies
// garment brightness while keeping buttons, weave, and silhouette alpha intact.
// Across the chest, use the shallow normal variation of a rounded torso. The
// neck and underarm occlusion are broad and fixed to the torso's own frame.
function makeTile(sleeve, direction) {
  const ctx = canvas2D(sleeve ? 32 : 80, sleeve ? 32 : 80);
  const { width, height } = ctx.canvas;
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5) / width) * 2 - 1;
      const radius = Math.abs(u);
      let shadow;
      if (sleeve) {
        shadow =
          (0.016 + 0.15 * radius ** 1.8 - 0.07 * direction * u) *
          (1 - ease(0.75, 1, radius)) *
          ease(0, 0.15, v) *
          (1 - ease(0.85, 1, v));
      } else {
        const bodyY = v * 1.9 - 0.36;
        const bodyX = u * 0.78;
        const side = limit(Math.abs(bodyX) / 0.55, 0, 1);
        const rim =
          (1 - ease(0.56, 0.78, Math.abs(bodyX))) *
          ease(-0.36, -0.14, bodyY) *
          (1 - ease(1.18, 1.54, bodyY));
        const collar = Math.exp(
          -(((bodyY + 0.045) / 0.105) ** 2 + (bodyX / 0.225) ** 2),
        );
        const underarm = Math.exp(
          -(
            ((bodyY - 0.23) / 0.27) ** 2 +
            ((Math.abs(bodyX) - 0.45) / 0.14) ** 2
          ),
        );
        shadow =
          (0.018 +
            0.12 * side ** 1.75 -
            0.07 * direction * Math.sign(bodyX) * side +
            0.065 * collar +
            0.048 * underarm) *
          rim;
      }
      image.data[(y * width + x) * 4 + 3] = Math.round(
        255 * limit(shadow, 0, 0.23),
      );
    }
  }
  ctx.putImageData(image, 0, 0);
  return ctx.canvas;
}

export function createLiveLighting() {
  let sampler,
    lastSource,
    lastSample = -Infinity,
    direction = 0,
    unreadable = false;
  const tiles = new Map();
  function tile(sleeve, light) {
    const step = Math.round(light * 5);
    const key = (sleeve ? "arm" : "torso") + step;
    if (!tiles.has(key)) tiles.set(key, makeTile(sleeve, step / 5));
    return tiles.get(key);
  }
  function reset() {
    lastSource = null;
    lastSample = -Infinity;
    direction = 0;
    unreadable = false;
    sampler = null;
  }
  function apply(ctx, product, points, source) {
    if (!source || product?.category === "bottom") return;
    const frame = ctx.canvas;
    const point = (i) => landmarkAt(points, i, frame);
    const ls = point(11),
      rs = point(12),
      lh = point(23),
      rh = point(24);
    if (!ls || !rs || !lh || !rh) return;
    const origin = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const down = {
      x: (lh.x + rh.x) / 2 - origin.x,
      y: (lh.y + rh.y) / 2 - origin.y,
    };
    const sign = ls.x > rs.x ? -1 : 1;
    const across = { x: sign * (rs.x - ls.x), y: sign * (rs.y - ls.y) };
    const span = Math.hypot(across.x, across.y);
    if (
      span < 10 ||
      down.y < 8 ||
      across.x * down.y - across.y * down.x < span * span * 0.28
    )
      return;
    const arms = [];
    for (const i of [13, 14]) {
      const start = point(i),
        end = point(i + 2);
      if (!start || !end) continue;
      const dx = end.x - start.x,
        dy = end.y - start.y,
        length2 = dx * dx + dy * dy;
      if (length2 > 1) arms.push({ start, dx, dy, length2 });
    }
    if (source !== lastSource) {
      reset();
      lastSource = source;
    }
    const now = performance.now();
    if (!unreadable && now - lastSample >= 250) {
      try {
        sampler ||= canvas2D(40, 32, true);
        const light = measure(
          sampler,
          source,
          { frame, origin, across, down, span },
          arms,
        );
        const weight = Math.min(1, (now - lastSample) / 750);
        direction += (light - direction) * weight;
      } catch (e) {
        // A cross-origin image can still be displayed. Drop the tainted sampler
        // and keep neutral, geometry-only shading for the remainder of this source.
        if (e?.name === "SecurityError") {
          sampler = null;
          unreadable = true;
        }
        direction = 0;
      }
      lastSample = now;
    }
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.imageSmoothingEnabled = true;
    ctx.save();
    ctx.transform(across.x, across.y, down.x, down.y, origin.x, origin.y);
    ctx.drawImage(tile(false, direction), -0.78, -0.36, 1.56, 1.9);
    ctx.restore();
    // Sleeves share the room light. Restrict their shading to the outboard
    // side of the torso so a wrist crossing the waist cannot shade the hem.
    for (const i of [11, 12]) {
      const shoulder = i === 11 ? ls : rs,
        elbow = point(i + 2),
        wrist = point(i + 4);
      if (!elbow || (!product.anatomy && !product.shape?.sleeves)) continue;
      const side = shoulder.x < origin.x ? -1 : 1;
      ctx.save();
      ctx.transform(across.x, across.y, down.x, down.y, origin.x, origin.y);
      ctx.beginPath();
      ctx.rect(side === -1 ? -4 : 0.56, -3, 3.44, 7);
      ctx.clip();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const drawTube = (a, b, radius) => {
        const dx = b.x - a.x,
          dy = b.y - a.y,
          length = Math.hypot(dx, dy);
        if (length < 2) return;
        const nx = dy / length,
          ny = -dx / length;
        ctx.save();
        ctx.transform(nx * radius, ny * radius, dx, dy, a.x, a.y);
        ctx.drawImage(tile(true, direction * nx), -1, 0, 2, 1);
        ctx.restore();
      };
      drawTube(shoulder, elbow, span * 0.2);
      if (wrist && product.sleeveLength === "long")
        drawTube(elbow, wrist, span * 0.16);
      ctx.restore();
    }
    ctx.restore();
  }
  return { apply, reset };
}
