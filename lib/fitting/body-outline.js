// Measurements use a shoulder-aligned frame. One unit equals the visible distance
// between shoulder joints, which keeps widths independent of photo framing and zoom.
const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
const mix = (a, b, t) => a + (b - a) * t;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

function consistent(values, tolerance, minCount = 3) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < minCount) return null;
  const center = median(valid);
  const cluster = valid.filter((v) => Math.abs(v - center) <= tolerance);
  return cluster.length >= Math.max(minCount, valid.length * 0.65)
    ? median(cluster)
    : null;
}

function readPixels(pixels, canvas) {
  if (pixels?.data && pixels.width && pixels.height) return pixels;
  if (!canvas || !canvas.width || !canvas.height) return null;
  try {
    return canvas
      .getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
}

function sampler(source, channels, toPixel) {
  const { width, height, data } = source;
  return (x, y) => {
    const p = toPixel(x, y);
    const u = Math.round(p.x * (width - 1)),
      v = Math.round(p.y * (height - 1));
    if (u < 0 || u >= width || v < 0 || v >= height) return null;
    const i = (v * width + u) * channels;
    return channels === 1 ? data[i] : [data[i], data[i + 1], data[i + 2]];
  };
}

function colorDistance(a, b) {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

// Used only without a usable person mask. Infer foreground against verified,
// locally consistent background colors. Skip rooms with clutter and weak contrast.
function colorForeground(rgb, y, side) {
  const samples = [];
  for (const u of [0.95, 1.12, 1.3, 1.48]) {
    for (const dy of [-0.09, 0, 0.09]) {
      const color = rgb(side * u, y + dy);
      if (color) samples.push(color);
    }
  }
  if (samples.length < 6) return null;
  const bg = [0, 1, 2].map((c) => median(samples.map((p) => p[c])));
  if (
    samples.filter((c) => colorDistance(c, bg) < 18).length <
    samples.length * 0.8
  )
    return null;
  const core = rgb(0, y);
  if (!core || colorDistance(core, bg) < 32) return null;
  return (u, v) => {
    const pixel = rgb(u, v);
    if (!pixel) return null;
    return colorDistance(pixel, bg) > 24;
  };
}

/** Returns independent width/radius measurements or null for unsupported evidence.
 * points: 33 normalized MediaPipe landmarks. mask: {width,height,data}, Float32 [0,1]
 * or Uint8 [0,255]. canvas or pixels (ImageData) supply an optional plain-background
 * fallback. imageWidth/imageHeight refer to the full input photo, not the mask.
 */
export function measureBodyOutline({
  points,
  mask,
  canvas,
  pixels,
  imageWidth,
  imageHeight,
}) {
  if (!points || points.length < 33) return null;
  const width = imageWidth || canvas?.width || pixels?.width || mask?.width;
  const height =
    imageHeight || canvas?.height || pixels?.height || mask?.height;
  if (!(width > 0 && height > 0)) return null;

  function point(index) {
    const p = points[index];
    if (
      !p ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      Math.min(p.confidence ?? 1, p.visibility ?? 1, p.presence ?? 1) < 0.55 ||
      p.x < 0 ||
      p.x > 1 ||
      p.y < 0 ||
      p.y > 1
    )
      return null;
    return { x: p.x * width, y: p.y * height };
  }
  const shoulders = [point(11), point(12)];
  if (shoulders.some((p) => !p)) return null;
  const imageLeft = shoulders[0].x < shoulders[1].x ? 0 : 1;
  const left = shoulders[imageLeft],
    right = shoulders[1 - imageLeft];
  const center = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  const span = Math.hypot(right.x - left.x, right.y - left.y);
  if (span < Math.max(12, width * 0.045)) return null;
  const ex = (right.x - left.x) / span,
    ey = (right.y - left.y) / span;
  if (ex < 0.83) return null;
  function local(index) {
    const p = point(index);
    if (!p) return null;
    const dx = (p.x - center.x) / span,
      dy = (p.y - center.y) / span;
    return { x: dx * ex + dy * ey, y: -dx * ey + dy * ex };
  }
  function toPixel(x, y) {
    return {
      x: (center.x + (ex * x - ey * y) * span) / width,
      y: (center.y + (ey * x + ex * y) * span) / height,
    };
  }
  const hips = [local(23), local(24)];
  if (hips.some((p) => !p)) return null;
  const hip = {
    x: (hips[0].x + hips[1].x) / 2,
    y: (hips[0].y + hips[1].y) / 2,
  };
  if (hip.y < 0.6 || hip.y > 2.6 || Math.abs(hip.x) > 0.65) return null;
  const centerAt = (y) => (hip.x * y) / hip.y;
  const axisStep = clamp(1 / span, 0.009, 0.024);

  let foreground = null;
  if (
    mask?.width > 0 &&
    mask?.height > 0 &&
    mask?.data?.length === mask.width * mask.height
  ) {
    const sample = sampler(mask, 1, toPixel);
    const cutoff = mask.data.BYTES_PER_ELEMENT === 1 ? 112 : 0.44;
    const fg = (x, y) => {
      const v = sample(x, y);
      return v === null ? null : v > cutoff;
    };
    if ([0.15, 0.34, 0.58, 0.8].every((t) => fg(hip.x * t, hip.y * t)))
      foreground = fg;
  }
  const appearance = !foreground && readPixels(pixels, canvas);
  const rgb = appearance ? sampler(appearance, 4, toPixel) : null;
  if (!foreground && !rgb) return null;
  const sampleAt = (y, side) => foreground || colorForeground(rgb, y, side);

  // Trace outward from a known foreground point. A short run of outside
  // samples avoids cutting on isolated holes; a crop edge is never accepted.
  function trace(fg, x, y, dx, dy, low, high) {
    if (!fg || fg(x, y) !== true) return null;
    let firstOutside = null;
    for (let r = axisStep; r <= high + axisStep * 2; r += axisStep) {
      const inside = fg(x + dx * r, y + dy * r);
      if (inside === null) return null;
      if (inside) firstOutside = null;
      else {
        if (firstOutside === null) firstOutside = r - axisStep * 0.5;
        if (r - firstOutside >= axisStep * 1.4) {
          return firstOutside >= low && firstOutside <= high
            ? firstOutside
            : null;
        }
      }
    }
    return null;
  }

  function measureSide(sign, sideIndex) {
    const shoulder = local(11 + sideIndex);
    const elbow = local(13 + sideIndex),
      wrist = local(15 + sideIndex);

    function radius(a, b, fractions, low, high) {
      if (!a || !b) return null;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.22 || len > 1.7) return null;
      let normalX = (b.y - a.y) / len,
        normalY = (a.x - b.x) / len;
      if (normalX * sign < 0) {
        normalX *= -1;
        normalY *= -1;
      }
      return consistent(
        fractions.map((t) => {
          const x = mix(a.x, b.x, t),
            y = mix(a.y, b.y, t);
          // A limb crossing the torso has no independent outer silhouette here.
          if ((x - centerAt(y)) * sign < 0.35 || Math.abs(normalX) < 0.3)
            return null;
          const fg = sampleAt(y, sign);
          return trace(fg, x, y, normalX, normalY, low, high);
        }),
        0.05,
      );
    }
    const upperArm = radius(
      shoulder,
      elbow,
      [0.3, 0.38, 0.46, 0.54, 0.62],
      0.045,
      0.26,
    );
    const forearm = radius(
      elbow,
      wrist,
      [0.28, 0.36, 0.44, 0.52, 0.6],
      0.035,
      0.205,
    );
    const wristRadius = radius(
      elbow,
      wrist,
      [0.79, 0.83, 0.87, 0.91, 0.95],
      0.022,
      0.15,
    );

    // When the arm touches the torso, a person mask has one continuous
    // foreground component. Derive the side seam from the measured arm axis
    // and radius instead of mistaking the outer arm for the waist.
    function armAt(y) {
      for (const [a, b, r] of [
        [shoulder, elbow, upperArm],
        [elbow, wrist, forearm],
      ]) {
        if (!a || !b || !r || Math.abs(b.y - a.y) < 0.15) continue;
        const t = (y - a.y) / (b.y - a.y);
        if (t < 0 || t > 1) continue;
        const axis = (mix(a.x, b.x, t) - centerAt(y)) * sign;
        const inclination = Math.abs(
          (b.y - a.y) / Math.hypot(b.x - a.x, b.y - a.y),
        );
        if (axis > 0.37 && inclination > 0.65)
          return { axis, radius: r / inclination };
      }
      return null;
    }
    function outer(t, low, high, excludeArm) {
      const y = hip.y * t;
      const r = trace(sampleAt(y, sign), centerAt(y), y, sign, 0, low, high);
      if (r === null || !excludeArm) return r;
      const arm = armAt(y);
      if (!arm) return r;
      // A gap already exposes a garment edge. A contiguous outside-arm edge
      // instead lands at or past the limb centerline.
      if (r < arm.axis - arm.radius * 0.32) return r;
      return Math.min(r, Math.max(low, arm.axis - arm.radius * 0.74));
    }
    const shoulderWidth = consistent(
      [0.01, 0.035, 0.06, 0.085, 0.11].map((t) => outer(t, 0.43, 0.83, false)),
      0.065,
    );
    const chest = consistent(
      [0.26, 0.3, 0.34, 0.38, 0.42].map((t) => outer(t, 0.32, 0.94, true)),
      0.065,
    );
    const waist = consistent(
      [0.65, 0.7, 0.75, 0.8, 0.85].map((t) => outer(t, 0.26, 0.91, true)),
      0.065,
    );
    const shoulderLift = consistent(
      [0.445, 0.46, 0.475, 0.49, 0.505].map((offset) => {
        const y = 0.07 * hip.y,
          x = offset * sign;
        const distance = trace(sampleAt(y, sign), x, y, 0, -1, 0.01, 0.4 + y);
        if (!Number.isFinite(distance)) return null;
        const lift = distance - y;
        return lift >= -0.04 && lift <= 0.205 ? lift : null;
      }),
      0.035,
    );
    // Follow the neck-to-deltoid slope at its actual transverse position.
    // A lift sampled above the joint cannot also describe the lower, round
    // outside of the arm. Suppress hair and cropped boundaries by requiring
    // foreground below and an observed, locally stable background above.
    const shoulderArc = [];
    const plausible = (x) =>
      x < 0.29 ? -0.38 : x < 0.42 ? -0.34 : x < 0.54 ? -0.29 : -0.22;
    const xs = [
      0.22, 0.27, 0.32, 0.37, 0.42, 0.47, 0.52, 0.57, 0.62, 0.67, 0.72, 0.77,
      0.82,
    ];
    for (const x of xs) {
      const observations = [-0.014, 0, 0.014].map((delta) => {
        const u = (x + delta) * sign;
        // Sample colors against a torso-level background reference rather
        // than require a torso at the neck height.
        const fg = sampleAt(0.08 * hip.y, sign);
        if (!fg) return null;
        let outside = 0;
        let run = 0;
        let start = 0;
        for (let y = -0.43; y < 0.32 * hip.y; y += axisStep) {
          const value = fg(u, y);
          if (value === null) return null;
          if (!value) {
            outside++;
            run = 0;
            continue;
          }
          if (!run) start = y - axisStep * 0.5;
          if (++run >= 3 && outside >= 2)
            return start >= plausible(x) ? start : null;
        }
        return null;
      });
      const y = consistent(observations, 0.055);
      if (
        y !== null &&
        (shoulderArc.length === 0 || y >= shoulderArc.at(-1).y - 0.085)
      ) {
        shoulderArc.push({ x, y });
      }
    }
    return {
      shoulder: shoulderWidth,
      shoulderLift,
      shoulderArc,
      chest,
      waist,
      upperArm,
      forearm,
      wrist: wristRadius,
    };
  }

  const measurements = {
    left: measureSide(-1, imageLeft),
    right: measureSide(1, 1 - imageLeft),
    source: foreground ? "segmentation" : "plain-background",
  };
  return [measurements.left, measurements.right].some((side) =>
    [side.shoulder, side.chest, side.waist].some(Number.isFinite),
  )
    ? measurements
    : null;
}
