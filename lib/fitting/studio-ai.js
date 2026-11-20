import { runWeShopTrial } from "./weshop-trial.js";
import { photoJpeg } from "./ai-try-on.js";

const api = "/api/ai-tryon";

async function reply(url, options) {
  const result = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
  });
  let data;
  try {
    data = await result.json();
  } catch {
    throw new Error(
      "The fitting studio could not read the AI service response.",
    );
  }
  if (!result.ok)
    throw new Error(data.error || "The AI fitting service is unavailable.");
  return data;
}

export async function getAiCapability(signal) {
  return reply(api, { signal });
}

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("The studio could not open an input photo."));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function pause(signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, 2800);
    function cancel() {
      clearTimeout(timer);
      reject(new DOMException("Stopped waiting.", "AbortError"));
    }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export async function generateStudioTryOn({
  person,
  garment,
  category = "top",
  garmentPhotoType = "flat-lay",
  providerId,
  signal,
  consent,
  onStatus = () => {},
}) {
  if (
    consent !== true ||
    !["studio", "fashn", "weshop-trial"].includes(providerId)
  ) {
    throw new Error(
      "Review where both photos will be sent and choose Generate.",
    );
  }
  const job = new AbortController();
  let timedOut = false;
  const cancel = () => job.abort();
  const deadline = setTimeout(() => {
    timedOut = true;
    job.abort();
  }, 8 * 60_000);
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    onStatus("Preparing the model and product photos…");
    const [personJpeg, garmentJpeg] = await Promise.all(
      [person, garment].map((src) => photoJpeg(src, job.signal)),
    );
    if (providerId === "weshop-trial") {
      const blob = await runWeShopTrial({
        personJpeg,
        garmentJpeg,
        consent,
        signal: job.signal,
        onStatus,
      });
      return dataUrl(blob);
    }
    const [modelPhoto, productPhoto] = await Promise.all([
      dataUrl(personJpeg),
      dataUrl(garmentJpeg),
    ]);
    const submission = await reply(api, {
      method: "POST",
      signal: job.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person: modelPhoto,
        garment: productPhoto,
        category,
        garmentPhotoType,
        providerId,
        consent: true,
      }),
    });
    if (typeof submission.job !== "string")
      throw new Error("The service did not confirm this fitting.");
    const statusUrl = api + "?job=" + encodeURIComponent(submission.job);
    onStatus("Your fitting is queued…");
    for (;;) {
      await pause(job.signal);
      const result = await reply(statusUrl, { signal: job.signal });
      if (result.status === "completed" && typeof result.image === "string")
        return result.image;
      if (!["in_queue", "starting", "processing"].includes(result.status))
        throw new Error("The AI service returned an incomplete fitting.");
      onStatus(
        result.status === "processing"
          ? "Rendering the garment on your photo…"
          : "Your fitting is queued…",
      );
    }
  } catch (error) {
    if (timedOut)
      throw new Error(
        "The rendering service has taken longer than eight minutes. The job may still finish on the provider.",
      );
    if (signal?.aborted)
      throw new DOMException("Stopped waiting.", "AbortError");
    throw error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
  }
}
