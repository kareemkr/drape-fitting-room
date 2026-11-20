const space = "https://weshopai-weshopai-virtual-try-on.hf.space";
const api = space + "/gradio_api";
let trialSession;

function session() {
  if (trialSession) return trialSession;
  const key = "drape-weshop-trial-session";
  try {
    trialSession = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, trialSession);
  } catch {
    trialSession = crypto.randomUUID();
  }
  return trialSession;
}

async function request(url, options) {
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    ...options,
  });
  if (response.ok) return response;
  if (response.status === 429 || response.status === 403) {
    throw new Error(
      "WeShopAI has limited access to this public trial. Try again later.",
    );
  }
  throw new Error(
    "WeShopAI’s public trial is unavailable. Your photos have not produced an AI result.",
  );
}

async function upload(blob, name, signal) {
  const form = new FormData();
  form.append("files", blob, name);
  const paths = await (
    await request(api + "/upload", { method: "POST", body: form, signal })
  ).json();
  if (
    !Array.isArray(paths) ||
    typeof paths[0] !== "string" ||
    paths[0].length > 1024
  ) {
    throw new Error("WeShopAI could not open the uploaded image.");
  }
  return {
    path: paths[0],
    orig_name: name,
    mime_type: "image/jpeg",
    meta: { _type: "gradio.FileData" },
  };
}

function outputLocation(item) {
  if (!item || (!item.url && !item.path))
    throw new Error("WeShopAI returned no fitted image.");
  const location = new URL(
    item.url || api + "/file=" + encodeURI(item.path),
    space,
  );
  if (
    location.origin !== space ||
    !location.pathname.startsWith("/gradio_api/file=")
  ) {
    throw new Error("WeShopAI returned an unexpected image location.");
  }
  return location.href;
}

async function imageLocation(response, id, onStatus) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The WeShopAI trial did not return a result.");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (buffer.length > 256 * 1024)
        throw new Error("WeShopAI returned an unreadable fitting.");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      if (done && buffer.trim()) lines.push(buffer);
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const evt = JSON.parse(line.slice(5));
        if (evt.event_id && evt.event_id !== id) continue;
        if (evt.msg === "process_starts")
          onStatus("WeShopAI is rendering your fitting…");
        if (evt.msg === "process_completed") {
          if (!evt.success)
            throw new Error(
              "WeShopAI could not render this pair. The public trial may have reached its limit.",
            );
          return outputLocation(evt.output?.data?.[0]);
        }
        if (evt.msg === "queue_full")
          throw new Error("The public trial queue is full. Try again later.");
        if (evt.msg === "close_stream")
          throw new Error("The public trial closed before a fitting arrived.");
      }
      if (done)
        throw new Error("The public trial closed before a fitting arrived.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function runWeShopTrial({
  personJpeg,
  garmentJpeg,
  consent,
  signal,
  onStatus = () => {},
}) {
  if (consent !== true)
    throw new Error(
      "Choose to send these photos to the WeShopAI public trial first.",
    );
  onStatus("Sending the garment and model photos to WeShopAI…");
  const refs = await Promise.all([
    upload(garmentJpeg, "garment.jpg", signal),
    upload(personJpeg, "model.jpg", signal),
  ]);
  // The public Gradio app includes a State input in addition to its two image inputs.
  const id = session();
  const config = await (await request(space + "/config", { signal })).json();
  const action = config.dependencies?.find(
    (dep) => dep.api_name === "generate_image",
  );
  if (!Number.isInteger(action?.id))
    throw new Error("WeShopAI’s public trial interface has changed.");
  const submission = await (
    await request(api + "/queue/join", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [...refs, null],
        session_hash: id,
        fn_index: action.id,
        event_data: null,
        trigger_id: null,
      }),
    })
  ).json();
  if (!/^[a-zA-Z0-9_-]{3,128}$/.test(submission?.event_id || ""))
    throw new Error("WeShopAI did not confirm this fitting.");
  onStatus("Waiting for WeShopAI’s public trial…");
  const stream = await request(
    api + "/queue/data?session_hash=" + encodeURIComponent(id),
    { signal, headers: { Accept: "text/event-stream" } },
  );
  const output = await request(
    await imageLocation(stream, submission.event_id, onStatus),
    { signal },
  );
  if (
    !/^image\/(jpeg|png|webp)\b/i.test(output.headers.get("content-type") || "")
  )
    throw new Error("WeShopAI returned an unreadable image.");
  const blob = await output.blob();
  if (!blob.size || blob.size > 20 * 1024 * 1024)
    throw new Error("WeShopAI returned an unsupported image size.");
  return blob;
}
