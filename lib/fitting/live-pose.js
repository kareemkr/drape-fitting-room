import { enablePoseAssetCache } from "./pose-asset-cache.js";
// Both backends use same-origin model files. Points always refer to the original,
// unmirrored video frame, even when the UI presents a mirrored selfie preview.
const assetRoot = "/pose-assets";
const cpuSize = 192;
const missingPoint = () => ({ x: 0, y: 0, z: 0, confidence: 0 });
const emptyPose = (status = "missing") => ({
  status,
  fullBody: false,
  points: null,
});
const clamp = (n, a, b) => Math.max(a, Math.min(n, b));
const stopped = () => new DOMException("Body tracking stopped.", "AbortError");

function normalize(raw) {
  if (!Array.isArray(raw) || raw.length !== 33) return null;
  return raw.map((p) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
      return missingPoint();
    const score = p.confidence ?? Math.min(p.visibility ?? 1, p.presence ?? 1);
    return {
      x: p.x,
      y: p.y,
      z: Number.isFinite(p.z) ? p.z : 0,
      confidence: Number.isFinite(score) ? clamp(score, 0, 1) : 0,
    };
  });
}

function visible(p, min) {
  return (
    p &&
    p.confidence >= min &&
    p.x > 0.005 &&
    p.x < 0.995 &&
    p.y > 0.005 &&
    p.y < 0.995
  );
}

// Evaluate framing on this frame's observations. Smoothing never upgrades a
// missing wrist, knee or ankle to a confident one.
function framing(points) {
  const shoulders = [points[11], points[12]];
  if (!shoulders.every((p) => visible(p, 0.49))) return "missing";
  if (
    Math.hypot(
      shoulders[0].x - shoulders[1].x,
      shoulders[0].y - shoulders[1].y,
    ) < 0.028
  )
    return "missing";
  const legs = [23, 24, 25, 26, 27, 28].map((i) => points[i]);
  const nose = points[0];
  if (!visible(nose, 0.4) || !legs.every((p) => visible(p, 0.4)))
    return "partial";
  const shoulderY = (shoulders[0].y + shoulders[1].y) / 2;
  const ankleY = Math.max(points[27].y, points[28].y);
  const span = ankleY - nose.y;
  // MoveNet measures ankles only; reserve a little room for shoes and the crown.
  const headroom = Math.max(0.008, (shoulderY - nose.y) * 0.58);
  const toes = [29, 30, 31, 32]
    .map((i) => points[i])
    .filter((p) => p.confidence >= 0.48);
  if (toes.some((p) => p.x <= 0 || p.x >= 1)) return "partial";
  const footY =
    toes.length >= 2
      ? Math.max(ankleY, ...toes.map((p) => p.y))
      : ankleY + span * 0.03;
  return span >= 0.17 && nose.y > headroom && footY < 0.997
    ? "full"
    : "partial";
}

function filtered(previous, current, elapsed) {
  if (!previous || elapsed <= 0 || elapsed > 450) return current;
  // An abrupt center shift generally means a new subject or a camera reframe.
  if (
    Math.abs(
      (previous[11].x + previous[12].x - current[11].x - current[12].x) / 2,
    ) > 0.16
  )
    return current;
  return current.map((p, i) => {
    const old = previous[i];
    if (old.confidence < 0.35 || p.confidence < 0.35) return p;
    const displacement = Math.hypot(p.x - old.x, p.y - old.y);
    const velocity = displacement / Math.max(0.008, elapsed / 1000);
    const timeConstant = 80 / (1 + velocity * 7);
    const weight = 1 - Math.exp(-elapsed / timeConstant);
    return {
      x: old.x + (p.x - old.x) * weight,
      y: old.y + (p.y - old.y) * weight,
      z: old.z + (p.z - old.z) * weight,
      confidence: p.confidence,
    };
  });
}

function createCpuEngine(plainJs = false) {
  if (typeof Worker !== "function")
    throw new Error(
      "Live body tracking requires WebGL 2 or a browser with worker support.",
    );
  const input = document.createElement("canvas");
  input.width = input.height = cpuSize;
  const context = input.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw new Error("The camera image could not be read on this device.");
  const worker = new Worker(
    plainJs ? "/pose-cpu/worker.js" : "/pose-cpu/live-worker.js",
  );
  let current = null;
  let failure = null;
  let sequence = 0;
  function finish(error, points) {
    if (!current) return;
    const { resolve, reject, timer } = current;
    current = null;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(points ? [points] : []);
  }
  function fail() {
    failure = new Error(
      "The on-device body tracker could not run. Reopen the camera to try again.",
    );
    worker.terminate();
    finish(failure);
  }
  worker.onerror = fail;
  worker.onmessageerror = fail;
  worker.onmessage = ({ data }) => {
    if (!current || data.id !== current.id) return;
    if (data.reason) {
      fail();
      return;
    }
    finish(null, data.points);
  };
  return {
    backend: "movenet",
    plainJs,
    detect(video) {
      if (failure) throw failure;
      const w = video.videoWidth,
        h = video.videoHeight;
      const scale = cpuSize / Math.max(w, h);
      const width = Math.max(1, Math.round(w * scale)),
        height = Math.max(1, Math.round(h * scale));
      const frame = {
        width,
        height,
        left: Math.floor((cpuSize - width) / 2),
        top: Math.floor((cpuSize - height) / 2),
      };
      context.fillStyle = "black";
      context.fillRect(0, 0, cpuSize, cpuSize);
      context.drawImage(video, frame.left, frame.top, width, height);
      const buffer = context.getImageData(0, 0, cpuSize, cpuSize).data.buffer;
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        current = {
          id,
          resolve,
          reject,
          timer: setTimeout(fail, id === 1 ? 30000 : 7500),
        };
        try {
          worker.postMessage({ id, frame, buffer }, [buffer]);
        } catch {
          fail();
        }
      });
    },
    close() {
      worker.terminate();
      finish(stopped());
    },
  };
}

async function createMediaPipeEngine(signal, delegate) {
  const surface = document.createElement("canvas");
  let gl;
  try {
    gl = surface.getContext("webgl2", {
      alpha: false,
      antialias: false,
      // Prefer the off-thread SIMD backend when hardware acceleration is unavailable.
      failIfMajorPerformanceCaveat: true,
    });
  } catch {
    return null;
  }
  if (!gl) return null;
  let model;
  let released = false;
  function close() {
    if (released) return;
    released = true;
    try {
      model?.close();
    } catch {
      /* A lost context may already be closed. */
    }
    try {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      /* Already released. */
    }
  }
  try {
    // Some browser builds allow a software WebGL context even with the caveat
    // flag. In those environments, keep inference off the UI thread.
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (
      info &&
      /swiftshader|llvmpipe|softpipe|software rasterizer/i.test(
        gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
      )
    ) {
      close();
      return null;
    }
    const { FilesetResolver, PoseLandmarker } = await import(
      "./vendor/vision_bundle.mjs"
    );
    const files = await FilesetResolver.forVisionTasks(assetRoot + "/wasm");
    if (signal?.aborted) throw stopped();
    model = await PoseLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: assetRoot + "/pose_landmarker_lite.task",
        delegate,
      },
      canvas: surface,
      runningMode: "VIDEO",
      numPoses: 2,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
    if (signal?.aborted) throw stopped();
    return {
      backend: delegate === "GPU" ? "mediapipe" : "mediapipe-cpu",
      detect(video, time) {
        const result = model.detectForVideo(video, time);
        try {
          return result.landmarks;
        } finally {
          result.close();
        }
      },
      close,
    };
  } catch {
    close();
    if (signal?.aborted) throw stopped();
    // CPU/XNNPACK still uses a WebGL2 surface for video input conversion.
    return delegate === "GPU" ? createMediaPipeEngine(signal, "CPU") : null;
  }
}

export async function createLivePoseTracker({ signal } = {}) {
  if (signal?.aborted) throw stopped();
  await enablePoseAssetCache();
  if (signal?.aborted) throw stopped();
  let engine = await createMediaPipeEngine(signal, "GPU");
  if (signal?.aborted) {
    engine?.close();
    throw stopped();
  }
  if (!engine) engine = createCpuEngine();
  let previous = null;
  let previousTime = -1;
  let modelTime = -1;
  let dimensions = "";
  let running = false;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", close);
    engine.close();
    previous = null;
  }
  signal?.addEventListener("abort", close, { once: true });
  return {
    get backend() {
      return engine.backend;
    },
    async detect(video, timestamp = performance.now()) {
      if (closed) throw stopped();
      if (running) throw new Error("A camera frame is already being measured.");
      if (!video?.videoWidth || !video.videoHeight || video.readyState < 2) {
        previous = null;
        return emptyPose();
      }
      running = true;
      try {
        const size = video.videoWidth + "x" + video.videoHeight;
        if (size !== dimensions) {
          previous = null;
          dimensions = size;
        }
        const time = Math.max(
          modelTime + 0.01,
          Number.isFinite(timestamp) ? timestamp : performance.now(),
        );
        modelTime = time;
        let people;
        while (true) {
          try {
            people = await engine.detect(video, time);
            break;
          } catch (error) {
            if (closed) throw stopped();
            const failedBackend = engine.backend;
            if (failedBackend === "movenet" && engine.plainJs) throw error;
            engine.close();
            // A damaged binary or unavailable WASM runtime can terminate a
            // worker before TFJS selects its built-in scalar fallback.
            if (failedBackend === "movenet") {
              previous = null;
              engine = createCpuEngine(true);
              continue;
            }
            previous = null;
            const next =
              failedBackend === "mediapipe"
                ? await createMediaPipeEngine(signal, "CPU")
                : null;
            if (closed) {
              next?.close();
              throw stopped();
            }
            engine = next ?? createCpuEngine();
          }
        }
        if (closed) throw stopped();
        const points = people.length === 1 ? normalize(people[0]) : null;
        const status =
          people.length > 1 ? "multiple" : points ? framing(points) : "missing";
        if (status === "missing" || status === "multiple") {
          previous = null;
          return emptyPose(status);
        }
        previous = filtered(previous, points, time - previousTime);
        previousTime = time;
        return { points: previous, status, fullBody: status === "full" };
      } finally {
        running = false;
      }
    },
    close,
  };
}
