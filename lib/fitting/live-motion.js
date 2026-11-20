// Inference uses measured camera frames. The display clock can run at a higher
// rate by blending between measured locations for a few frames after each fix.
const keyJoints = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const movingMs = 90;
const restingMs = 225;
const lookingMs = 170;

function score(p) {
  return p?.confidence ?? p?.visibility ?? 0;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function measureMovement(before, after, dt) {
  // Measure displacement in shoulder widths, so a person standing farther away
  // can activate fast tracking by moving an arm just as someone nearby can.
  const shoulderWidth = Math.max(0.045, distance(after[11], after[12]));
  const deadband = Math.max(0.0015, shoulderWidth * 0.013);
  const speeds = [];
  let displacement = 0;
  for (const i of keyJoints) {
    if (score(before[i]) < 0.5 || score(after[i]) < 0.5) continue;
    const delta = distance(before[i], after[i]);
    displacement = Math.max(displacement, delta);
    speeds.push(
      (Math.max(0, delta - deadband) * 1000) /
        (shoulderWidth * Math.max(22, dt)),
    );
  }
  speeds.sort((a, b) => b - a);
  // Require two moving joints for small motions; a distinct wrist or ankle
  // movement can reactivate the tracker on its own.
  return { moving: speeds[0] > 0.57 || speeds[1] > 0.22, displacement };
}

function blend(from, to, fraction) {
  if (fraction >= 1 || !from) return to;
  const t = Math.max(0, fraction);
  const weight = t * (2 - t);
  return to.map((p, i) => {
    const a = from[i];
    if (score(a) < 0.45 || score(p) < 0.45) return p;
    return {
      ...p,
      x: a.x + (p.x - a.x) * weight,
      y: a.y + (p.y - a.y) * weight,
      z: (a.z ?? 0) + ((p.z ?? 0) - (a.z ?? 0)) * weight,
    };
  });
}

export function createLiveMotion() {
  let from, target, measuredAt, receivedAt, expiresAt, blendMs, activeUntil;
  let cadence, inferenceMs;
  function reset() {
    from = target = null;
    measuredAt = receivedAt = expiresAt = -Infinity;
    activeUntil = -Infinity;
    blendMs = inferenceMs = 0;
    cadence = lookingMs;
  }
  reset();

  function sample(now) {
    if (!target || now >= expiresAt) return null;
    if (!blendMs || now >= receivedAt + blendMs) return target;
    return blend(from, target, (now - receivedAt) / blendMs);
  }

  return {
    reset,
    sample,
    interval() {
      // On a slow device allow some idle time after each completed inference.
      return Math.max(cadence, Math.ceil(inferenceMs * 1.18));
    },
    push(points, time, now, staleMs = 500) {
      const duration = Math.max(0, now - time);
      if (!points || points.length !== 33) {
        reset();
        inferenceMs = duration;
        return;
      }
      if (time <= measuredAt) return;
      const previous = target;
      const start = sample(now);
      const dt = time - measuredAt;
      const cut =
        !start ||
        !previous ||
        Math.abs(
          (previous[11].x + previous[12].x - points[11].x - points[12].x) / 2,
        ) > 0.19;
      if (cut) {
        from = null;
        blendMs = 0;
        activeUntil = now + 450;
      } else {
        const { moving, displacement } = measureMovement(previous, points, dt);
        if (moving) activeUntil = now + 450;
        from = start;
        // New confidence always takes effect immediately. Only coordinates are
        // animated, within the segment joining two measured positions.
        blendMs =
          displacement > 0.0008 ? Math.min(72, Math.max(20, dt * 0.42)) : 0;
      }
      cadence = now < activeUntil ? movingMs : restingMs;
      target = points;
      measuredAt = time;
      receivedAt = now;
      expiresAt = now + Math.max(0, staleMs);
      inferenceMs = duration;
    },
  };
}
