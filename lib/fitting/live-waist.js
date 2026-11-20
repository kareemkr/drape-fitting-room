import { landmarkAt } from "./live-fullbody.js";

// A fit attachment on each side of the torso. Pose models report shoulder and
// hip joints, so these intermediate points are estimates, not measured waists.
const waistFraction = 0.70;
const carryMs = 420;
const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function toShoulderSpace(point, center, u, span) {
  const x = (point.x - center.x) / span;
  const y = (point.y - center.y) / span;
  return { x: x * u.x + y * u.y, y: y * u.x - x * u.y };
}

function observe(points, frame) {
  if (!(Number.isFinite(frame?.width) && frame.width > 0 &&
        Number.isFinite(frame?.height) && frame.height > 0)) return null;
  function joint(i) {
    const p = points?.[i];
    const score = p?.confidence ?? Math.min(p?.visibility ?? 1, p?.presence ?? 1);
    if (!Number.isFinite(score)) return null;
    const pixel = landmarkAt(points, i, frame);
    return pixel && { x: pixel.x + (frame.left ?? 0), y: pixel.y + (frame.top ?? 0) };
  }
  const first = joint(11), second = joint(12);
  if (!first || !second) return null;
  const ids = first.x <= second.x ? [11, 12] : [12, 11];
  const shoulders = ids[0] === 11 ? [first, second] : [second, first];
  const [left, right] = shoulders;
  const span = distance(left, right);
  if (span < frame.width * 0.05 || right.x - left.x < span * 0.60) return null;
  const center = mix(left, right, 0.5);
  const u = { x: (right.x - left.x) / span, y: (right.y - left.y) / span };
  // Resolve geometry in shoulder-width units using the native image aspect ratio.
  const hips = ids.map((id) => {
    const p = joint(id + 12);
    return p && toShoulderSpace(p, center, u, span);
  });
  return { ids, shoulders, center, span, u, hips };
}

function plausible(hips) {
  const [a, b] = hips;
  if (!a || !b) return false;
  const mid = mix(a, b, 0.5);
  const width = b.x - a.x;
  return width > 0.16 && width < 1.72 && Math.abs(b.y - a.y) < 0.78 &&
    mid.y > 0.57 && mid.y < 2.8 && Math.abs(mid.x) < 1.12;
}

function profile(body, localHips, carried = [false, false]) {
  const { ids, shoulders, span, center, u } = body;
  const hips = localHips.map((p) => ({
    x: center.x + (p.x * u.x - p.y * u.y) * span,
    y: center.y + (p.x * u.y + p.y * u.x) * span,
  }));
  const waist = shoulders.map((p, side) => mix(p, hips[side], waistFraction));
  return { ids, shoulders, hips, waist, waistCenter: mix(...waist, 0.5), waistFraction, carried };
}

/** Unmirrored frame pixels, ordered image-left to image-right. No temporal state. */
export function deriveLiveWaist(points, frame) {
  const body = observe(points, frame);
  return body && plausible(body.hips) ? profile(body, body.hips) : null;
}

/** Fallback for a cropped still photo. Live tracking never initializes from
 * these assumed proportions. The body may extend outside the photo crop.
 */
export function estimatePhotoWaist(points, frame) {
  const body = observe(points, frame);
  if (!body || body.hips.every(Boolean) || body.u.x < 0.82) return null;
  if (!body.ids.every((id) => landmarkAt(points, id, frame, 0.60))) return null;
  const [a, b] = body.ids.map((id) => points[id]);
  // MediaPipe reports depth in normalized image-width units. A strong depth
  // difference between shoulders is insufficient support for this frontal fit.
  if (Number.isFinite(a.z) && Number.isFinite(b.z) &&
      Math.abs(a.z - b.z) * frame.width > body.span * 0.90) return null;
  const hips = [{ x: -0.365, y: 1.4 }, { x: 0.365, y: 1.4 }];
  return { ...profile(body, hips), source: "shoulder-estimate", estimated: true };
}

/** Display interpolation never counts as new tracking evidence. A carried hip
 * stays attached to the torso even if the animation interpolates a raw outlier.
 */
export function projectLiveWaist(points, frame, measured, previous) {
  if (!measured) return null;
  const body = observe(points, frame);
  if (!body || body.ids[0] !== measured.ids[0]) return null;
  const sameOrder = previous?.ids[0] === measured.ids[0];
  const carried = measured.carried.map((held, i) =>
    Boolean(held || (sameOrder && previous.carried[i]) || !body.hips[i]),
  );
  if (!carried.includes(true) && plausible(body.hips)) return profile(body, body.hips);

  const [a, b] = measured.shoulders;
  const span = distance(a, b);
  const u = { x: (b.x - a.x) / span, y: (b.y - a.y) / span };
  const center = mix(a, b, 0.5);
  const hips = measured.hips.map((p) => toShoulderSpace(p, center, u, span));
  // Use the other interpolated hip to carry the verified pelvic width and tilt.
  // If neither hip is reliable, the current shoulders carry the entire pelvis.
  if (carried[0] !== carried[1]) {
    const fixed = carried[0] ? 0 : 1;
    const moving = 1 - fixed;
    const shift = { x: body.hips[moving].x - hips[moving].x, y: body.hips[moving].y - hips[moving].y };
    hips[moving] = body.hips[moving];
    hips[fixed] = { x: hips[fixed].x + shift.x, y: hips[fixed].y + shift.y };
    if (plausible(hips)) return profile(body, hips, carried);
    return null;
  }
  return profile(body, hips, [true, true]);
}

/** Call once per measured frame. A missing pose resets the calibration. */
export function createLiveWaistTracker() {
  let lastBody, lastTime, lastSize, calibration, calibratedAt, candidate;
  function reset() {
    lastBody = calibration = candidate = null;
    lastTime = calibratedAt = -Infinity;
    lastSize = "";
  }
  reset();

  function update(points, frame, timestamp) {
    const body = observe(points, frame);
    if (!body || !Number.isFinite(timestamp)) {
      reset();
      return null;
    }
    const size = `${frame.width}x${frame.height}`;
    const dt = timestamp - lastTime;
    if (lastBody && (dt < 0 || dt > 950 || lastSize !== size ||
        lastBody.ids[0] !== body.ids[0] || distance(lastBody.center, body.center) > frame.width * 0.20 ||
        body.span < lastBody.span * 0.60 || body.span > lastBody.span * 1.68)) reset();
    lastBody = body;
    lastTime = timestamp;
    lastSize = size;

    const hips = body.hips;
    // Whole-body translation, camera zoom, and shoulder roll have already
    // been removed. Common motion of BOTH hips (a genuine lean) passes through.
    const delta = hips.map((p, side) => p && calibration ? distance(p, calibration[side]) : Infinity);
    let unreliableSide = -1;
    if (calibration) {
      const larger = delta[0] > delta[1] ? 0 : 1;
      const other = 1 - larger;
      const tolerance = 0.19 + 0.00045 * Math.min(Math.max(dt, 0), 220);
      if (delta[larger] > delta[other] * 2 + tolerance) unreliableSide = larger;
    }
    const valid = plausible(hips);
    // Moving both hips symmetrically towards two outstretched hands can still
    // give a plausible center. Discard a sudden change of the pelvis vector.
    const vectorJump = valid && calibration && Math.hypot(
      (hips[1].x - hips[0].x) - (calibration[1].x - calibration[0].x),
      (hips[1].y - hips[0].y) - (calibration[1].y - calibration[0].y),
    ) > 0.42;
    const bothSuspect = vectorJump && unreliableSide === -1;
    let accepted = valid && unreliableSide === -1 && !bothSuspect;
    if (!accepted && valid && calibration) {
      // A real pelvis rotation can move just one joint abruptly. Reacquire it
      // after distinct, consistent observations of a compatible pelvic span.
      const lengthRatio = distance(...hips) / distance(...calibration);
      if (lengthRatio >= 0.77 && lengthRatio <= 1.28) {
        if (!candidate || hips.some((p, i) => distance(p, candidate.hips[i]) > 0.075)) {
          candidate = { hips, first: timestamp, last: timestamp, count: 1 };
        } else if (timestamp > candidate.last) {
          candidate.count++;
          candidate.last = timestamp;
        }
        accepted = candidate.count >= 3 && timestamp - candidate.first >= 160;
      } else candidate = null;
    } else candidate = null;
    if (accepted) {
      candidate = null;
      calibration = hips;
      calibratedAt = timestamp;
      return profile(body, hips);
    }
    if (!calibration || timestamp - calibratedAt > carryMs) return null;

    // The good hip may continue to move relative to the shoulders. Carry its
    // partner by the last measured pelvis vector, with no wrist/hand dependency.
    const side = delta[0] <= delta[1] ? 0 : 1;
    if (!bothSuspect && delta[side] < 0.28 && hips[side]) {
      const other = 1 - side;
      const pair = hips.slice();
      pair[other] = {
        x: hips[side].x + calibration[other].x - calibration[side].x,
        y: hips[side].y + calibration[other].y - calibration[side].y,
      };
      const carried = [false, false];
      carried[other] = true;
      return profile(body, pair, carried);
    }
    return profile(body, calibration, [true, true]);
  }
  return { reset, update };
}
