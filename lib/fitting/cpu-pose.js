// This fallback uses a same-origin CPU-only worker. The only image it receives is a
// 192px letterboxed raster; no uploaded image is sent to the network.
const inputSize = 192;
let worker;
let nextId = 0;
const pending = new Map();

function releaseWorker() {
  worker?.terminate();
  worker = undefined;
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.resolve(null);
  }
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker("/pose-cpu/worker.js");
  worker.onerror = releaseWorker;
  worker.onmessageerror = releaseWorker;
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    clearTimeout(job.timer);
    pending.delete(data.id);
    job.resolve(
      Array.isArray(data.points) && data.points.length === 33
        ? data.points
        : null,
    );
  };
  return worker;
}

export async function detectCpuPose(photo) {
  if (typeof Worker === "undefined") return null;
  const width = photo?.naturalWidth || photo?.width;
  const height = photo?.naturalHeight || photo?.height;
  if (!(width > 0 && height > 0)) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = inputSize;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const scale = inputSize / Math.max(width, height);
    const frame = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
    frame.left = Math.floor((inputSize - frame.width) / 2);
    frame.top = Math.floor((inputSize - frame.height) / 2);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, inputSize, inputSize);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(photo, frame.left, frame.top, frame.width, frame.height);
    const buffer = ctx.getImageData(0, 0, inputSize, inputSize).data.buffer;
    const detector = getWorker();
    return await new Promise((resolve) => {
      const id = ++nextId;
      const timer = setTimeout(releaseWorker, 25000);
      pending.set(id, { timer, resolve });
      try {
        detector.postMessage({ id, frame, buffer }, [buffer]);
      } catch {
        releaseWorker();
      }
    });
  } catch {
    return null;
  }
}
