// All geometry is in the unmirrored camera coordinate system. The mask removes
// pixels from the garment overlay; the video supplies the original fingers.
import { landmarkAt } from "./live-fullbody.js";

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mix = (a, b, t) => a + (b - a) * t;
const between = (a, b, t) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });

function crop(bounds, frame) {
  const x = Math.max(0, Math.floor(bounds.left));
  const y = Math.max(0, Math.floor(bounds.top));
  return {
    x, y,
    width: Math.min(frame.width, Math.ceil(bounds.right)) - x,
    height: Math.min(frame.height, Math.ceil(bounds.bottom)) - y,
  };
}

function torsoDepth(wrist, shoulders, hips) {
  // A hand resting on the near hip can be behind the near shoulder. Compare
  // it with the body surface at its own position, including torso yaw.
  const across = (pair) => {
    const [a, b] = pair;
    const t = Math.abs(b.x - a.x) > 1 ? clamp((wrist.x - a.x) / (b.x - a.x)) : 0.5;
    return { y: mix(a.y, b.y, t), z: mix(a.z, b.z, t) };
  };
  const upper = across(shoulders);
  if (!hips.every(Boolean)) return upper.z;
  const lower = across(hips);
  const down = clamp((wrist.y - upper.y) / Math.max(1, lower.y - upper.y));
  return mix(upper.z, lower.z, down);
}

function handRegion(product, landmark, wristIndex, shoulders, hips, span, frame, isMoveNet) {
  const wrist = landmark(wristIndex, isMoveNet ? 0.40 : 0.56);
  const elbow = landmark(wristIndex - 2, isMoveNet ? 0.38 : 0.43);
  if (!wrist || !elbow) return null;
  const reach = distance(wrist, elbow);
  if (reach < span * 0.07 || reach > span * 1.7) return null;
  const mid = between(shoulders[0], shoulders[1], 0.5);
  if (Math.abs(wrist.x - mid.x) > span * 1.55) return null;
  const plane = torsoDepth(wrist, shoulders, hips);
  const depthSlop = (span / frame.width) * 0.16;
  if (wrist.z > plane + depthSlop) return null;
  const thumb = landmark(wristIndex + 6, 0.50);
  const fingers = [landmark(wristIndex + 2, 0.50), landmark(wristIndex + 4, 0.50), thumb]
    .filter(p => p && distance(wrist, p) > span * 0.045 && distance(wrist, p) < span * 0.63);
  const center = fingers.length >= 2 ? {
    x: fingers.reduce((sum, p) => sum + p.x, 0) / fingers.length,
    y: fingers.reduce((sum, p) => sum + p.y, 0) / fingers.length,
  } : between(wrist, elbow, -Math.min(0.65, span * (isMoveNet ? 0.42 : 0.34) / reach));
  const segments = [];
  function segment(a, b, r1, r2) {
    const dx = b.x - a.x, dy = b.y - a.y;
    segments.push({ a, b, dx, dy, length2: Math.max(0.01, dx * dx + dy * dy), r1: span * r1, r2: span * r2 });
  }
  segment(wrist, center, 0.088, fingers.length >= 2 ? 0.143 : isMoveNet ? 0.17 : 0.13);
  // Pose landmarks on the index/pinky often land near the knuckles. Search
  // past them for connected visible fingers, capped by the shoulder scale.
  for (const tip of fingers) {
    const extension = Math.min(2.18, span * 0.52 / distance(wrist, tip));
    segment(between(wrist, center, 0.6), between(wrist, tip, extension), 0.128, tip === thumb ? 0.15 : 0.102);
  }
  // MoveNet stops at the wrist. A raised elbow and medial wrist at the side
  // of the waist allow the palm to turn inward independently of the forearm.
  // This enlarges only the search region; solid pixels still need a color
  // boundary and a connected path to observed skin at the wrist.
  const sparseHand = isMoveNet && fingers.length === 0;
  const offset = wrist.x - mid.x;
  if (sparseHand && Math.abs(offset) > span * 0.25 && wrist.y > mid.y + span * 0.45 &&
      Math.abs(elbow.x - mid.x) > Math.abs(offset) + span * 0.10) {
    const inward = { x: wrist.x - Math.sign(offset) * span * 0.49, y: wrist.y };
    segment(wrist, inward, 0.117, 0.17);
  }
  const long = product.sleeveLength === "long" && product.category !== "bottom";
  if (!long) {
    const elbowDepth = elbow.z - torsoDepth(elbow, shoulders, hips);
    const wristDepth = wrist.z - plane;
    const crossing = elbowDepth > depthSlop && Number.isFinite(wristDepth)
      ? clamp((elbowDepth - depthSlop) / Math.max(0.001, elbowDepth - wristDepth)) : 0;
    segment(between(elbow, wrist, crossing), wrist, mix(0.108, 0.083, crossing), 0.083);
  }
  const margin = span * 0.17;
  const ends = segments.flatMap(s => [s.a, s.b]);
  const rect = crop({
    left: Math.min(...ends.map(p => p.x)) - margin,
    top: Math.min(...ends.map(p => p.y)) - margin,
    right: Math.max(...ends.map(p => p.x)) + margin,
    bottom: Math.max(...ends.map(p => p.y)) + margin,
  }, frame);
  if (rect.width < 2 || rect.height < 2) return null;
  return { rect, segments, wrist, elbow, reach, span, long, sparseHand };
}

function colorSample(data, offset) {
  const r = data[offset], g = data[offset + 1], b = data[offset + 2];
  const sum = r + g + b + 36;
  return [(r - g) / sum, (g - b) / sum, Math.log(sum)];
}

function readFaceProfile(landmark, frame, span, readPatch, isMoveNet) {
  const eyeConfidence = isMoveNet ? 0.33 : 0.46;
  const nose = landmark(0, isMoveNet ? 0.4 : 0.55);
  const left = landmark(2, eyeConfidence), right = landmark(5, eyeConfidence);
  if (!nose || !left || !right) return null;
  const spread = distance(left, right);
  if (spread < 2 || spread > span * 0.55) return null;
  const samples = [];
  const radius = clamp(spread * 0.15, 1, 7);
  // Calibrate from the visible subject each frame. The comparison uses
  // normalized color and local exposure variation, with no skin-tone table.
  const cheeks = [left, right].map(eye => ({
    x: mix(nose.x, eye.x, 0.8),
    y: nose.y + (nose.y - eye.y) * 0.15,
  }));
  const sites = [nose, ...cheeks];
  const rect = crop({
    left: Math.min(...sites.map(p => p.x)) - radius,
    right: Math.max(...sites.map(p => p.x)) + radius + 1,
    top: Math.min(...sites.map(p => p.y)) - radius,
    bottom: Math.max(...sites.map(p => p.y)) + radius + 1,
  }, frame);
  if (rect.width < 2 || rect.height < 1) return null;
  const patch = readPatch(rect, 48);
  if (!patch) return null;
  for (let y = 0; y < patch.height; y++) {
    for (let x = 0; x < patch.width; x++) {
      const sx = rect.x + (x + 0.5) * rect.width / patch.width;
      const sy = rect.y + (y + 0.5) * rect.height / patch.height;
      if (!sites.some(p => Math.hypot(sx - p.x, sy - p.y) <= radius + 0.3)) continue;
      const offset = 4 * (y * patch.width + x);
      if (patch.data[offset + 3] < 220) continue;
      samples.push(colorSample(patch.data, offset));
    }
  }
  if (samples.length < 3) return null;
  const ranges = [0, 1, 2].map(channel => {
    const values = samples.map(sample => sample[channel]).sort((a, b) => a - b);
    const median = values[Math.floor(values.length * 0.5)];
    const deviations = values.map(x => Math.abs(x - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(values.length / 2)];
    return { median, mad };
  });
  return {
    rg: ranges[0].median, gb: ranges[1].median, light: ranges[2].median,
    rgRange: clamp(0.045 + 2.4 * ranges[0].mad, 0.045, 0.088),
    gbRange: clamp(0.045 + 2.4 * ranges[1].mad, 0.045, 0.082),
    lightRange: clamp(0.66 + 1.6 * ranges[2].mad, 0.66, 1.03),
  };
}

function readClothingColor(shoulders, hips, span, frame, readPatch, profile) {
  const upper = between(...shoulders, 0.5);
  const lower = hips.every(Boolean) ? between(...hips, 0.5) : { x: upper.x, y: upper.y + span * 1.35 };
  const middle = between(upper, lower, 0.48);
  const rect = crop({ left: middle.x - span * 0.14, right: middle.x + span * 0.14,
    top: middle.y - span * 0.10, bottom: middle.y + span * 0.10 }, frame);
  if (rect.width < 2 || rect.height < 2) return null;
  const patch = readPatch(rect, 12);
  if (!patch) return null;
  const rg = [], gb = [];
  for (let i = 0; i < patch.data.length; i += 4) {
    if (patch.data[i + 3] < 230) continue;
    const sample = colorSample(patch.data, i);
    rg.push(sample[0]);
    gb.push(sample[1]);
  }
  if (rg.length < 4) return null;
  const median = list => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const baseRG = median(rg), baseGB = median(gb);
  const dr = profile.rg - baseRG, dg = profile.gb - baseGB;
  const separation = dr * dr + dg * dg;
  if (separation < 0.045 ** 2) return null;
  return { rg: baseRG, gb: baseGB, dr, dg, separation };
}

function matte(region, profile, clothing, image) {
  const { width, height, data } = image;
  const { rect, wrist, elbow, long, reach, span, segments } = region;
  const length = width * height;
  const alpha = new Uint8ClampedArray(length);
  const visited = new Uint8Array(length);
  const queue = new Int32Array(length);
  let count = 0, ring = 0, ringMatches = 0;
  for (let y = 0, i = 0; y < height; y++) {
    const sy = rect.y + (y + 0.5) * rect.height / height;
    for (let x = 0; x < width; x++, i++) {
      const sx = rect.x + (x + 0.5) * rect.width / width;
      // The long sleeve overrides visible source forearm skin up to the cuff.
      if (long && ((sx - wrist.x) * (wrist.x - elbow.x) + (sy - wrist.y) * (wrist.y - elbow.y)) / reach < -span * 0.025) continue;
      let radial = Infinity;
      for (const s of segments) {
        const dx = sx - s.a.x, dy = sy - s.a.y;
        const t = clamp((dx * s.dx + dy * s.dy) / s.length2);
        const ex = dx - t * s.dx, ey = dy - t * s.dy;
        const r = mix(s.r1, s.r2, t);
        radial = Math.min(radial, (ex * ex + ey * ey) / (r * r));
      }
      if (radial > 2.12 || data[4 * i + 3] < 160) continue;
      const offset = i * 4, r = data[offset], g = data[offset + 1], b = data[offset + 2];
      const sum = r + g + b + 36;
      const rg = (r - g) / sum, gb = (g - b) / sum, light = Math.log(sum);
      const colorError = Math.max(Math.abs(rg - profile.rg) / profile.rgRange,
        Math.abs(gb - profile.gb) / profile.gbRange, Math.abs(light - profile.light) / profile.lightRange);
      if (radial > 1.10) {
        ring++;
        if (colorError < 1) ringMatches++;
        continue;
      }
      // Require actual foreground pixels even inside the reported finger hull.
      let evidence = clamp((1.24 - colorError) / 0.36);
      if (clothing) {
        const towardSkin = ((rg - clothing.rg) * clothing.dr + (gb - clothing.gb) * clothing.dg) / clothing.separation;
        evidence *= clamp((towardSkin - 0.21) / 0.29);
      }
      alpha[i] = Math.round(255 * Math.min(evidence, clamp((1.10 - radial) / 0.23)));
      const byWrist = !region.sparseHand || !long ||
        (sx - wrist.x) ** 2 + (sy - wrist.y) ** 2 <= (span * 0.20) ** 2;
      if (alpha[i] > 180 && radial < 0.46 && byWrist) {
        visited[i] = 1;
        queue[count++] = i;
      }
    }
  }
  // An enclosing patch of the same color (e.g. a beige old shirt) offers
  // no usable boundary. Retain the new garment instead of cutting a hand shape.
  if (!count || (ring > 8 && ringMatches > ring * 0.89)) return null;
  function visit(i) {
    if (!visited[i] && alpha[i] > 12) {
      visited[i] = 1;
      queue[count++] = i;
    }
  }
  for (let head = 0; head < count; head++) {
    const i = queue[head], x = i % width;
    if (x > 0) visit(i - 1);
    if (x + 1 < width) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < length) visit(i + width);
  }
  for (let i = 0; i < length; i++) if (!visited[i]) alpha[i] = 0;
  return { rect, width, height, alpha };
}

// readPatch returns RGBA for a requested camera rectangle at a bounded size.
// Keeping this independent of the DOM also allows replaying exact frame data.
export function foregroundHandMasks(product, points, frame, readPatch, backend) {
  // Raw keypoint scores have different calibration across the two estimators.
  // Only the tracker can identify MoveNet; a zero z is also valid MediaPipe data.
  const isMoveNet = backend === "movenet";
  const landmark = (i, min) => landmarkAt(points, i, frame, min);
  const shoulders = [landmark(11), landmark(12)];
  if (!shoulders.every(Boolean) || !readPatch) return [];
  const hips = [landmark(23), landmark(24)];
  const span = distance(...shoulders);
  if (span < 12) return [];
  const hands = [15, 16].map(i => handRegion(product, landmark, i, shoulders, hips, span, frame, isMoveNet)).filter(Boolean);
  if (!hands.length) return [];
  const profile = readFaceProfile(landmark, frame, span, readPatch, isMoveNet);
  if (!profile) return [];
  const clothing = readClothingColor(shoulders, hips, span, frame, readPatch, profile);
  return hands.flatMap(hand => {
    const pixels = readPatch(hand.rect, maxRegion);
    const result = pixels && matte(hand, profile, clothing, pixels);
    return result ? [result] : [];
  });
}

// Reuse the two small matte surfaces and the camera reader between frames.
const maxRegion = 144;

function surface(readFrequently = false) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = maxRegion;
  return canvas.getContext("2d", { willReadFrequently: readFrequently });
}

export function createLiveOcclusion() {
  let reader, masks = [], layers = [], cachedSource, cachedProduct;
  let cachedPose, cachedBackend, cachedTime = -1, cachedWidth = 0, cachedHeight = 0;
  function draw(ctx, product, points, frame, source, backend) {
    if (!source || (source.readyState != null && source.readyState < 2)) return;
    const clock = source.currentTime;
    // A new interpolated pose can arrive on the same camera frame. Recheck
    // when confidence changes or measured hand motion exceeds a source pixel.
    const samePose = points === cachedPose || (cachedPose && points && points.every((p, i) => {
      const old = cachedPose[i];
      return old && p && p.confidence === old.confidence &&
        Math.abs(p.x - old.x) * frame.width < 1 && Math.abs(p.y - old.y) * frame.height < 1 &&
        Math.abs((p.z ?? 0) - (old.z ?? 0)) < 0.01;
    }));
    if (source !== cachedSource || product !== cachedProduct || backend !== cachedBackend || !samePose ||
        !Number.isFinite(clock) || clock !== cachedTime ||
        frame.width !== cachedWidth || frame.height !== cachedHeight) {
      if (source !== cachedSource) reader = null;
      masks = [];
      cachedSource = source;
      cachedProduct = product;
      cachedBackend = backend;
      cachedPose = points;
      cachedTime = clock;
      cachedWidth = frame.width;
      cachedHeight = frame.height;
      reader ??= surface(true);
      if (!reader) return;
      const scaleX = (source.videoWidth || source.naturalWidth || source.width) / frame.width;
      const scaleY = (source.videoHeight || source.naturalHeight || source.height) / frame.height;
      if (!(scaleX > 0 && scaleY > 0)) return;
      const read = (rect, limit) => {
        const scale = Math.min(1, limit / Math.max(rect.width, rect.height));
        const width = Math.max(1, Math.round(rect.width * scale));
        const height = Math.max(1, Math.round(rect.height * scale));
        reader.clearRect(0, 0, width, height);
        reader.drawImage(source, rect.x * scaleX, rect.y * scaleY, rect.width * scaleX,
          rect.height * scaleY, 0, 0, width, height);
        return reader.getImageData(0, 0, width, height);
      };
      try {
        masks = foregroundHandMasks(product, points, frame, read, backend);
      } catch (error) {
        // Cross-origin images and a camera closing mid-draw have no readable
        // source pixels. Leave the garment intact for this frame.
        if (!["SecurityError", "IndexSizeError", "InvalidStateError"].includes(error?.name)) throw error;
      }
      masks.forEach((mask, index) => {
        const layer = layers[index] ??= surface();
        if (!layer) return;
        const rgba = layer.createImageData(mask.width, mask.height);
        for (let i = 0; i < mask.alpha.length; i++) rgba.data[i * 4 + 3] = mask.alpha[i];
        layer.putImageData(rgba, 0, 0);
      });
    }
    if (!masks.length) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    masks.forEach((mask, index) => {
      const layer = layers[index];
      if (layer) ctx.drawImage(layer.canvas, 0, 0, mask.width, mask.height,
        mask.rect.x, mask.rect.y, mask.rect.width, mask.rect.height);
    });
    ctx.restore();
  }
  function dispose() {
    masks = [];
    layers = [];
    cachedSource = cachedProduct = cachedPose = reader = null;
  }
  return { draw, dispose };
}
