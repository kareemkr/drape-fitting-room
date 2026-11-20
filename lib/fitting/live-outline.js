import { measureBodyOutline } from "./body-outline.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function landmark(points, i, width, height) {
  const p = points?.[i];
  return p &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Math.min(p.confidence ?? 1, p.visibility ?? 1, p.presence ?? 1) >= 0.55
    ? { x: p.x * width, y: p.y * height }
    : null;
}

function frameBasis(points, width, height) {
  const s = [
    landmark(points, 11, width, height),
    landmark(points, 12, width, height),
  ];
  if (s.some((p) => !p)) return null;
  const first = s[0].x < s[1].x ? 0 : 1,
    left = s[first],
    right = s[1 - first];
  const span = distance(left, right),
    ex = (right.x - left.x) / span,
    ey = (right.y - left.y) / span;
  if (span < 14 || ex < 0.83) return null;
  const cx = (left.x + right.x) / 2,
    cy = (left.y + right.y) / 2;
  function project(u, v) {
    return {
      x: cx + (u * ex - v * ey) * span,
      y: cy + (u * ey + v * ex) * span,
    };
  }
  function local(id) {
    const p = landmark(points, id, width, height);
    if (!p) return null;
    const dx = (p.x - cx) / span,
      dy = (p.y - cy) / span;
    return { x: dx * ex + dy * ey, y: dy * ex - dx * ey };
  }
  return { cx, cy, span, first, local, project };
}

// Reject backgrounds with multiple conflicting colors behind a side even if
// one level happens to resemble the clothing. The width tracer also verifies
// local foreground contrast and a contiguous edge at every measurement.
function plainSide(pixels, basis, sign) {
  const samples = [];
  for (const y of [-0.24, 0.02, 0.32, 0.62, 0.92, 1.25]) {
    for (const x of [1.03, 1.23, 1.45]) {
      const p = basis.project(sign * x, y),
        u = Math.round(p.x),
        v = Math.round(p.y);
      if (u < 0 || v < 0 || u >= pixels.width || v >= pixels.height) continue;
      const i = (v * pixels.width + u) * 4;
      if (pixels.data[i + 3] > 230)
        samples.push(pixels.data.subarray(i, i + 3));
    }
  }
  if (samples.length < 8) return null;
  const med = [0, 1, 2].map(
    (c) => samples.map((s) => s[c]).sort((a, b) => a - b)[samples.length >> 1],
  );
  return samples.filter(
    (p) => Math.max(...med.map((v, c) => Math.abs(v - p[c]))) <= 25,
  ).length >=
    samples.length * 0.72
    ? med
    : null;
}

// A tank or open neckline can make the center reference used by the width
// tracer match the wall. Trace the shoulder against the verified side color
// when there is clear background above it and sustained foreground below.
function exposedShoulder(pixels, basis, sign, bg) {
  const arc = [];
  const step = Math.max(0.011, 1 / basis.span);
  for (const u of [
    0.32, 0.37, 0.42, 0.47, 0.52, 0.57, 0.62, 0.67, 0.72, 0.77,
  ]) {
    let outside = 0,
      inside = 0,
      start = 0;
    for (let y = -0.55; y <= 0.32; y += step) {
      const p = basis.project(sign * u, y),
        x = Math.round(p.x),
        v = Math.round(p.y);
      if (x < 0 || x >= pixels.width || v < 0 || v >= pixels.height) break;
      const i = (v * pixels.width + x) * 4;
      const diff = Math.max(
        ...bg.map((n, ch) => Math.abs(pixels.data[i + ch] - n)),
      );
      if (diff <= 21) {
        outside++;
        inside = 0;
        continue;
      }
      if (diff < 32) {
        inside = 0;
        continue;
      }
      if (!inside) start = y - step * 0.5;
      if (++inside * step < 0.07) continue;
      if (
        outside * step > 0.1 &&
        start > -0.34 &&
        start < 0.26 &&
        (!arc.length || start >= arc.at(-1).y - 0.045)
      )
        arc.push({ x: u, y: start });
      break;
    }
  }
  return arc.length >= 5 && arc.at(-1).x - arc[0].x >= 0.22 ? arc : [];
}

// For a bent arm near the waist, the inside contour may be the shirt itself.
// A sequence of exterior background pixels still establishes one independent
// outside radius. Require agreement across multiple shaft stations.
function exteriorRadius(pixels, basis, sign, bg, a, b, stations) {
  if (!a || !b) return null;
  const length = distance(a, b);
  if (length < 0.25 || length > 1.55) return null;
  const nx = (sign * (b.y - a.y)) / length,
    ny = (sign * (a.x - b.x)) / length;
  const step = Math.max(0.009, 1.1 / basis.span),
    radii = [];
  const diff = (u, v) => {
    const pos = basis.project(u, v),
      x = Math.round(pos.x),
      y = Math.round(pos.y);
    if (x < 0 || x >= pixels.width || y < 0 || y >= pixels.height) return NaN;
    const k = (y * pixels.width + x) * 4;
    return Math.max(...bg.map((c, i) => Math.abs(pixels.data[k + i] - c)));
  };
  for (const t of stations) {
    const u = a.x + (b.x - a.x) * t,
      v = a.y + (b.y - a.y) * t;
    if (u * sign < 0.34 || !(diff(u, v) > 32)) continue;
    let count = 0,
      first = 0;
    for (let d = step; d <= 0.24 + step * 5; d += step) {
      const contrast = diff(u + nx * d, v + ny * d);
      if (!Number.isFinite(contrast)) break;
      if (contrast > 21) {
        count = 0;
        continue;
      }
      if (!count) first = d - step * 0.5;
      if (++count < 5) continue;
      if (first >= 0.035 && first <= 0.24 && (u + nx * first) * sign > 0.52)
        radii.push(first);
      break;
    }
  }
  if (radii.length < 3) return null;
  radii.sort((a, b) => a - b);
  const middle = radii[radii.length >> 1];
  return radii.filter((v) => Math.abs(v - middle) < 0.043).length >= 3
    ? middle
    : null;
}

// Measurements are shoulder-span ratios, ordered by image side. The live
// outline describes the shoulder and sleeve envelope only. Hands, existing
// clothes and the background cannot supply a new waist or chest attachment.
function measure(points, pixels, previous) {
  const basis = frameBasis(points, pixels.width, pixels.height);
  if (!basis) return null;
  const valid = [plainSide(pixels, basis, -1), plainSide(pixels, basis, 1)];
  if (!valid.some(Boolean)) return null;
  const raw = measureBodyOutline({ points, pixels });
  if (!raw) return null;
  const outline = { left: {}, right: {}, source: "plain-background" };
  for (const [side, name] of ["left", "right"].entries()) {
    if (!valid[side]) continue;
    const id = 11 + (side ? 1 - basis.first : basis.first),
      sign = side ? 1 : -1;
    const elbow = basis.local(id + 2),
      wrist = basis.local(id + 4),
      cap = { x: sign * 0.5, y: 0 };
    const otherWrist = basis.local(15 + (1 - (id - 11)));
    const target = outline[name],
      source = raw[name],
      prior = previous?.[name];
    const nearShoulder = [wrist, otherWrist].some(
      (p) => p && distance(p, cap) < 0.39,
    );
    function acceptMeasurement(key, allowed, lo, hi) {
      const value = source[key];
      if (!allowed || !Number.isFinite(value) || value < lo || value > hi)
        return;
      // Ignore subpixel readback jitter and limit changes on a moving arm.
      const last = prior?.[key];
      target[key] = Number.isFinite(last)
        ? Math.abs(value - last) < 0.012
          ? last
          : last + clamp(value - last, -0.12, 0.12) * 0.55
        : value;
    }
    const lowered =
      elbow && elbow.y > 0.2 && elbow.y / distance(cap, elbow) > 0.46;
    let arc = source.shoulderArc?.filter(
      (p) => p.x >= 0.26 && p.x <= 0.77 && p.y < 0.31,
    );
    if ((arc?.length ?? 0) < 4 && !nearShoulder && lowered)
      arc = exposedShoulder(pixels, basis, sign, valid[side]);
    if (!nearShoulder && lowered && arc?.length >= 4) {
      target.shoulderArc = arc.map((p) => {
        const old = prior?.shoulderArc?.find((a) => a.x === p.x);
        return {
          x: p.x,
          y: old ? old.y + 0.55 * clamp(p.y - old.y, -0.09, 0.09) : p.y,
        };
      });
    }
    acceptMeasurement("shoulder", !nearShoulder && lowered, 0.48, 0.79);
    acceptMeasurement(
      "upperArm",
      elbow && (sign * elbow.x > 0.38 || (sign * (elbow.x + cap.x)) / 2 > 0.44),
      0.06,
      0.245,
    );
    // Exclude the outline when a forearm turns into or overlaps the torso.
    const outerElbow = elbow && sign * elbow.x > 0.48,
      outerWrist = wrist && sign * wrist.x > 0.55;
    acceptMeasurement("forearm", outerElbow && outerWrist, 0.04, 0.185);
    acceptMeasurement("wrist", outerElbow && outerWrist, 0.025, 0.143);
    for (const [inner, key, stations] of [
      ["forearm", "outerForearm", [0.29, 0.38, 0.47, 0.56, 0.65]],
      ["wrist", "outerWrist", [0.77, 0.82, 0.87, 0.92, 0.97]],
    ]) {
      if (target[inner] !== undefined) continue;
      source[key] = exteriorRadius(
        pixels,
        basis,
        sign,
        valid[side],
        elbow,
        wrist,
        stations,
      );
      acceptMeasurement(key, true, 0.035, 0.24);
    }
  }
  return Object.keys(outline.left).length || Object.keys(outline.right).length
    ? outline
    : null;
}

export function createLiveOutline() {
  let sampler, source, lastTime, lastSample, observed, outline, blocked;
  function reset() {
    sampler = null;
    source = null;
    lastTime = lastSample = -Infinity;
    observed = outline = null;
    blocked = false;
  }
  reset();
  function sample(points, input, now = performance.now()) {
    if (!input || !Number.isFinite(now) || points?.length !== 33) {
      reset();
      return points;
    }
    const neutral = () => (points.outline ? points.slice() : points);
    if (input !== source || now < lastTime) {
      reset();
      source = input;
    }
    lastTime = now;
    const width = input.videoWidth || input.naturalWidth || input.width,
      height = input.videoHeight || input.naturalHeight || input.height;
    const body = frameBasis(points, width, height);
    if (!width || !height || !body || !body.local(23) || !body.local(24)) {
      outline = observed = null;
      return neutral();
    }
    const center = { x: body.cx / width, y: body.cy / height };
    const current = {
      center,
      span: body.span / width,
      first: body.first,
      arms: [13, 14, 15, 16].map(body.local),
    };
    const jump =
      observed &&
      (distance(center, observed.center) > 0.2 ||
        current.first !== observed.first ||
        Math.abs(Math.log(current.span / observed.span)) > 0.42);
    if (jump) {
      observed = outline = null;
    }
    const moving =
      !observed ||
      current.arms.some(
        (p, i) =>
          Boolean(p) !== Boolean(observed.arms[i]) ||
          (p && distance(p, observed.arms[i]) > 0.13),
      ) ||
      distance(center, observed.center) > 0.035;
    if (!blocked && now - lastSample >= (moving ? 450 : 1400)) {
      lastSample = now;
      observed = current;
      try {
        if (input.data?.length === width * height * 4) {
          outline = measure(points, input, outline);
        } else {
          // Read only a small torso/arm crop, even from a 4K camera stream.
          const corners = [
            body.project(-1.62, -0.55),
            body.project(1.62, -0.55),
            body.project(-1.62, 2.56),
            body.project(1.62, 2.56),
          ];
          const x = Math.max(
              0,
              Math.floor(Math.min(...corners.map((p) => p.x))),
            ),
            y = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y))));
          const w =
              Math.min(width, Math.ceil(Math.max(...corners.map((p) => p.x)))) -
              x,
            h =
              Math.min(
                height,
                Math.ceil(Math.max(...corners.map((p) => p.y))),
              ) - y;
          if (w < 14 || h < 14) {
            outline = null;
            return neutral();
          }
          const scale = Math.min(1, 256 / Math.max(w, h));
          const sw = Math.round(w * scale),
            sh = Math.round(h * scale);
          sampler ||= document
            .createElement("canvas")
            .getContext("2d", { willReadFrequently: true });
          if (sampler.canvas.width !== sw) sampler.canvas.width = sw;
          if (sampler.canvas.height !== sh) sampler.canvas.height = sh;
          sampler.drawImage(input, x, y, w, h, 0, 0, sw, sh);
          const pixels = sampler.getImageData(0, 0, sw, sh);
          const local = points.map(
            (p) =>
              p && {
                ...p,
                x: (p.x * width - x) / w,
                y: (p.y * height - y) / h,
              },
          );
          outline = measure(local, pixels, outline);
        }
      } catch (e) {
        outline = null;
        if (e?.name === "SecurityError") {
          sampler = null;
          blocked = true;
        }
      }
    }
    return outline ? Object.assign(points.slice(), { outline }) : neutral();
  }
  return { sample, reset };
}
