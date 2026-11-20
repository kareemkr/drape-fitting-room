/* Browser adapter for FASHN's official, public Gradio Space. */
const SPACE = "https://fashn-ai-fashn-vton-1-5.hf.space";
const API = SPACE + "/gradio_api";
const categories = {
  top: "tops",
  tops: "tops",
  bottom: "bottoms",
  bottoms: "bottoms",
  dress: "one-pieces",
  "one-pieces": "one-pieces",
};
const busyMessage =
  "The shared AI queue is busy or its daily allowance has been reached. You can still use the instant fitting.";

function providerError(status, detail = "") {
  if (
    status === 429 ||
    /quota|gpu duration|limit reached|queue is full/i.test(detail)
  )
    return new Error(busyMessage);
  if (status === 401 || status === 403)
    return new Error(
      "Hugging Face is restricting anonymous access right now. Try the instant fitting or return later.",
    );
  if (status === 503 || status === 504)
    return new Error(
      "The AI studio is starting up or busy. Try again in a few minutes.",
    );
  return new Error(
    "The AI studio could not finish this request. Your instant fitting is still available.",
  );
}

async function request(url, options) {
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    ...options,
  });
  if (!response.ok)
    throw providerError(
      response.status,
      (await response.text()).slice(0, 2000),
    );
  return response;
}

function rowResult(block) {
  let event = "";
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (event === "error") throw providerError(0, data.join(" "));
  if (event !== "complete") return null;
  const items = JSON.parse(data.join("\n"));
  const item = items[0];
  if (!item || (!item.url && !item.path)) throw providerError(0);
  const result = item.url
    ? new URL(item.url, SPACE)
    : new URL("/gradio_api/file=" + encodeURI(item.path), SPACE);
  if (
    result.origin !== SPACE ||
    !result.pathname.startsWith("/gradio_api/file=")
  )
    throw providerError(0);
  return result.href;
}

async function resultLocation(response) {
  if (!response.body) throw providerError(0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (buffer.length > 256 * 1024) throw providerError(0);
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      if (done && buffer.trim()) blocks.push(buffer);
      for (const block of blocks) {
        const result = rowResult(block);
        if (result) return result;
      }
      if (done) throw providerError(0);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function photoJpeg(source, signal) {
  const src = new URL(source, location.href);
  if (
    !["data:", "blob:"].includes(src.protocol) &&
    src.origin !== location.origin
  ) {
    throw new Error("Import the garment into the fitting room first.");
  }
  const blob = await (
    await request(src.href, { signal, credentials: "same-origin" })
  ).blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    signal.throwIfAborted();
    const factor = Math.min(
      1,
      1280 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * factor));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * factor));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error("The studio could not prepare this photo.")),
        "image/jpeg",
        0.89,
      ),
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/* Low-level transport accepts fresh, metadata-free JPEG blobs. It does no work without consent. */
export async function requestAiImage({
  personJpeg,
  garmentJpeg,
  category = "top",
  garmentPhotoType = "flat-lay",
  consent,
  signal,
  onStatus = () => {},
}) {
  if (consent !== true)
    throw new Error("Choose to send these two photos to the FASHN demo first.");
  const categoryName = categories[category];
  if (!categoryName)
    throw new Error(
      "Select a top, bottom or one-piece garment for the AI fitting.",
    );
  if (!["model", "flat-lay"].includes(garmentPhotoType))
    throw new Error("Choose a product-only or model-worn garment photo.");
  const form = new FormData();
  form.append("files", personJpeg, "portrait.jpg");
  form.append("files", garmentJpeg, "garment.jpg");
  onStatus("Sending the two photos…");
  const paths = await (
    await request(API + "/upload", { method: "POST", body: form, signal })
  ).json();
  if (
    !Array.isArray(paths) ||
    paths.length !== 2 ||
    paths.some((path) => typeof path !== "string")
  )
    throw providerError(0);
  const files = paths.map((path, index) => ({
    path,
    orig_name: index === 0 ? "portrait.jpg" : "garment.jpg",
    mime_type: "image/jpeg",
    meta: { _type: "gradio.FileData" },
  }));
  onStatus("Joining the shared GPU queue…");
  const submission = await (
    await request(API + "/call/try_on", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        data: [...files, categoryName, garmentPhotoType, 30, 1.5, 42, true],
      }),
    })
  ).json();
  if (
    typeof submission.event_id !== "string" ||
    !/^[A-Za-z0-9_-]{3,128}$/.test(submission.event_id)
  )
    throw providerError(0);
  onStatus("Waiting for the AI fitting…");
  const stream = await request(API + "/call/try_on/" + submission.event_id, {
    signal,
    headers: { Accept: "text/event-stream" },
  });
  const outputUrl = await resultLocation(stream);
  onStatus("Opening your result…");
  const result = await request(outputUrl, { signal });
  if (
    !(result.headers.get("content-type") || "").match(
      /^image\/(jpeg|png|webp)\b/i,
    )
  )
    throw providerError(0);
  return await result.blob();
}

/* Input images are same-origin URLs or local blob/data URLs. Output can be saved locally. */
export async function generateAiTryOn({
  person,
  garment,
  category = "top",
  garmentPhotoType = "flat-lay",
  consent,
  signal,
  onStatus = () => {},
}) {
  if (consent !== true)
    throw new Error("Choose to send these two photos to the FASHN demo first.");
  if (!person || !garment)
    throw new Error("Select a portrait and a garment first.");
  const job = new AbortController();
  const cancel = () => job.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    cancel();
  }, 180_000);
  try {
    onStatus("Preparing your images…");
    const [personJpeg, garmentJpeg] = await Promise.all([
      photoJpeg(person, job.signal),
      photoJpeg(garment, job.signal),
    ]);
    const output = await requestAiImage({
      personJpeg,
      garmentJpeg,
      category,
      garmentPhotoType,
      consent,
      signal: job.signal,
      onStatus,
    });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not open the AI result."));
      reader.readAsDataURL(output);
    });
  } catch (error) {
    if (timedOut)
      throw new Error(
        "The shared AI queue did not return a result in time. Please try again later.",
      );
    if (signal?.aborted)
      throw new DOMException(
        "Stopped waiting for the AI fitting.",
        "AbortError",
      );
    if (error instanceof TypeError)
      throw new Error(
        "Could not reach the public AI studio. You can still use the instant fitting.",
      );
    throw error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
  }
}
