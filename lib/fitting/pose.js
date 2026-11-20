import { enablePoseAssetCache } from "./pose-asset-cache.js";
import { measureBodyOutline } from "./body-outline.js";
import { detectCpuPose } from "./cpu-pose.js";
// MediaPipe runs on the device using the bundled SDK 0.10.21 and Lite float16 model v1.
// https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js
const sdkRoot = "/pose-assets";
const liteModel = sdkRoot + "/pose_landmarker_lite.task";
const cached = new Map();
let loading;
let retryAfter = 0;

function detector() {
  if (loading) return loading;
  if (Date.now() < retryAfter) return Promise.resolve(null);
  loading = (async () => {
    const probe = document.createElement("canvas");
    const graphics = probe.getContext("webgl2") || probe.getContext("webgl");
    if (!graphics) return null;
    graphics.getExtension("WEBGL_lose_context")?.loseContext();
    const { FilesetResolver, PoseLandmarker } = await import(
      "./vendor/vision_bundle.mjs"
    );
    const wasm = await FilesetResolver.forVisionTasks(sdkRoot + "/wasm");
    return PoseLandmarker.createFromOptions(wasm, {
      baseOptions: { modelAssetPath: liteModel, delegate: "CPU" },
      runningMode: "IMAGE",
      numPoses: 2,
      outputSegmentationMasks: true,
      minPoseDetectionConfidence: 0.55,
      minPosePresenceConfidence: 0.55,
    });
  })().catch(() => {
    loading = undefined;
    retryAfter = Date.now() + 60000;
    return null;
  });
  return loading;
}

export function getCachedPose(key) {
  return cached.get(key)?.value || null;
}

export function detectBodyPose(key, image) {
  const prior = cached.get(key);
  if (prior && (prior.value || Date.now() < prior.expires))
    return prior.promise;
  const entry = { value: null, expires: Infinity };
  entry.promise = (async () => {
    if (!globalThis.isSecureContext) return null;
    await enablePoseAssetCache();
    const factor = Math.min(
      1,
      640 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * factor));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * factor));
    canvas
      .getContext("2d", { willReadFrequently: true })
      .drawImage(image, 0, 0, canvas.width, canvas.height);
    let points = null;
    let result = null;
    try {
      const model =
        typeof WebAssembly === "undefined" ? null : await detector();
      if (model) {
        result = model.detect(canvas);
        if (result.landmarks.length > 1) return null;
        if (
          result.landmarks.length === 1 &&
          result.landmarks[0].length === 33
        ) {
          points = result.landmarks[0].map(
            ({ x, y, z, visibility, presence }) => ({
              x,
              y,
              z,
              confidence: Math.min(visibility ?? 1, presence ?? 1),
            }),
          );
          points.backend = "mediapipe-cpu";
          const personMask = result.segmentationMasks?.[0];
          const mask = personMask
            ? {
                width: personMask.width,
                height: personMask.height,
                data: personMask.getAsFloat32Array(),
              }
            : null;
          points.outline = measureBodyOutline({
            points,
            mask,
            canvas,
            imageWidth: canvas.width,
            imageHeight: canvas.height,
          });
        }
      }
    } catch {
      /* Some browsers lack a usable graphics context even with WebGL enabled. */
    } finally {
      result?.close?.();
    }
    if (!points) {
      points = await detectCpuPose(canvas);
      if (points) points.backend = "movenet";
    }
    if (!points) return null;
    if (!points.outline)
      points.outline = measureBodyOutline({
        points,
        canvas,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
      });
    entry.value = points;
    return points;
  })()
    .catch(() => null)
    .finally(() => {
      entry.expires = Date.now() + 60000;
    });
  cached.set(key, entry);
  if (cached.size > 5) cached.delete(cached.keys().next().value);
  return entry.promise;
}

const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Normalized image landmarks enter in MediaPipe's documented 33-point order.
 * All returned positions and lengths are canvas pixels. Rotation is in degrees.
 */
export function fitLandmarks(points, photo, category, garmentRatio) {
  if (!points || points.length < 33 || !(garmentRatio > 0)) return null;
  function landmark(index) {
    const p = points[index];
    if (
      !p ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      (p.confidence ?? p.visibility ?? 1) < 0.55 ||
      p.x < 0 ||
      p.x > 1 ||
      p.y < 0 ||
      p.y > 1
    )
      return null;
    return {
      x: photo.left + p.x * photo.width,
      y: photo.top + p.y * photo.height,
    };
  }
  const shoulders = [landmark(11), landmark(12)].sort(
    (a, b) => (a?.x ?? 0) - (b?.x ?? 0),
  );
  if (shoulders.some((p) => !p)) return null;
  const shoulder = midpoint(...shoulders),
    span = length(...shoulders);
  if (span < photo.width * 0.055 || span > photo.width * 0.84) return null;
  const hips = [landmark(23), landmark(24)].sort(
    (a, b) => (a?.x ?? 0) - (b?.x ?? 0),
  );
  const hasHips = hips.every(Boolean);
  const hip = hasHips
    ? midpoint(...hips)
    : { x: shoulder.x, y: shoulder.y + span * 1.38 };
  const torso = hip.y - shoulder.y;
  if (torso < span * 0.62 || torso > span * 2.55) return null;
  const lean = clamp((hip.x - shoulder.x) / torso, -0.4, 0.4);
  const isBottom = /bottom|trouser|pant|short|skirt|jean/i.test(category);
  const isDress = /dress|full|jumpsuit/i.test(category);
  const slope = isBottom && hasHips ? hips : shoulders;
  const tilt = clamp(
    (Math.atan2(slope[1].y - slope[0].y, slope[1].x - slope[0].x) * 180) /
      Math.PI,
    -22,
    22,
  );
  const top = isBottom ? hip.y - torso * 0.23 : shoulder.y - torso * 0.205;
  const topCX = isBottom
    ? hip.x + lean * (top - hip.y)
    : shoulder.x + lean * (top - shoulder.y);
  const ankles = [landmark(27), landmark(28)].filter(
    (p) => p && p.y > hip.y + torso * 0.65,
  );
  const knees = [landmark(25), landmark(26)].filter(
    (p) => p && p.y > hip.y + torso * 0.23,
  );
  let targetWidth, targetHeight;
  if (isBottom) {
    if (!hasHips) return null;
    const hipSpan = length(...hips);
    if (hipSpan < span * 0.35 || hipSpan > span * 1.6) return null;
    targetWidth = Math.max(span * 0.87, hipSpan * 1.57);
    const inferredLeg = knees.length
      ? (middle(knees.map((p) => p.y)) - hip.y) * 1.93
      : torso * 1.66;
    const ankleY = ankles.length
      ? middle(ankles.map((p) => p.y))
      : hip.y + inferredLeg;
    targetHeight = clamp(ankleY - top, torso * 0.86, torso * 2.7);
  } else if (isDress) {
    targetWidth = span * 1.62;
    const skirtEnd = knees.length
      ? middle(knees.map((p) => p.y))
      : hip.y + torso * 0.84;
    targetHeight = clamp(skirtEnd - top, torso * 1.55, torso * 2.65);
  } else {
    // A flat top without a usable pattern is still attached to the torso.
    targetWidth = span * 1.55;
    targetHeight = torso * 1.49;
  }
  // Retain the relative length of a short skirt, summer dress, or short-sleeve shirt.
  const width = Math.min(targetWidth, targetHeight * garmentRatio * 1.12);
  const height = Math.min(targetHeight, (width / garmentRatio) * 1.13);
  // Canvas rotates around the garment center. Compensate so the neckline/waistband remains
  // centered on its measured landmark even when the shoulders or pelvis are angled.
  const tiltRad = (tilt * Math.PI) / 180;
  const cx = topCX - (Math.sin(tiltRad) * height) / 2;
  return {
    cx,
    top,
    width,
    height,
    tilt,
    lean: clamp(lean + Math.tan(tiltRad), -0.28, 0.28),
  };
}
