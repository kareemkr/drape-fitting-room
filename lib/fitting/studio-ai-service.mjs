const API = "https://api.fashn.ai/v1";
const MANAGED = { providerId: "fashn", provider: "FASHN", model: "Try-On Max" };
const HOSTED = {
  providerId: "studio",
  provider: "the studio’s GPU service",
  model: "FASHN VTON v1.5",
};

function configuration(env) {
  if (env.DRAPE_RENDER_URL || env.DRAPE_RENDER_TOKEN) {
    try {
      const url = new URL(env.DRAPE_RENDER_URL);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        env.DRAPE_RENDER_TOKEN
      ) {
        return {
          ...HOSTED,
          base: url.href.replace(/\/$/, ""),
          secret: env.DRAPE_RENDER_TOKEN,
        };
      }
    } catch {
      /* An incomplete owner configuration disables live submission. */
    }
    return { ...HOSTED, secret: null };
  }
  return { ...MANAGED, base: API, secret: env.FASHN_API_KEY };
}
const IMAGE_LIMIT = 5 * 1024 * 1024;
const INPUT_LIMIT = 2 * IMAGE_LIMIT + 2048;
const encoder = new TextEncoder();
const categories = {
  top: "upper-body garment",
  bottom: "lower-body garment",
  dress: "one-piece garment",
};

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function fail(message, status) {
  return json({ error: message }, status);
}

async function limitedJson(request, limit) {
  if (Number(request.headers.get("content-length")) > limit || !request.body)
    return null;
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function jpeg(value) {
  return (
    typeof value === "string" &&
    value.length > 100 &&
    value.length <= IMAGE_LIMIT &&
    value.startsWith("data:image/jpeg;base64,/9j/") &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value.slice(23))
  );
}

function macKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function signatureInput(user, id, expiry) {
  return encoder.encode(JSON.stringify(["drape-fashn-v1", user, id, expiry]));
}

async function ticketFor(user, id, secret) {
  const expiry = String(Date.now() + 55 * 60_000);
  const sig = await crypto.subtle.sign(
    "HMAC",
    await macKey(secret),
    signatureInput(user, id, expiry),
  );
  const hex = Array.from(new Uint8Array(sig), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [id, expiry, hex].join(".");
}

async function openTicket(ticket, user, secret) {
  const match = /^([a-zA-Z0-9_-]{3,120})\.(\d{13})\.([a-f0-9]{64})$/.exec(
    ticket,
  );
  if (!match || Number(match[2]) <= Date.now()) return null;
  const [, id, expiry, hex] = match;
  const signature = Uint8Array.from(hex.match(/../g), (pair) =>
    parseInt(pair, 16),
  );
  return (await crypto.subtle.verify(
    "HMAC",
    await macKey(secret),
    signature,
    signatureInput(user, id, expiry),
  ))
    ? id
    : null;
}

function providerFailure(status, error) {
  const name = typeof error?.name === "string" ? error.name : "";
  if (status === 401 || status === 403)
    return fail("The AI provider rejected the studio’s credentials.", 503);
  if (status === 402 || /Credit|Balance/i.test(name))
    return fail("The studio’s AI provider has insufficient credits.", 503);
  if (status === 404 || status === 410)
    return fail("This fitting has expired or is no longer available.", 410);
  if (status === 429)
    return fail("The AI provider is busy. Try again later.", 429);
  if (
    status === 422 ||
    /Input|ImageLoad|Pose|Garment|ContentModeration/i.test(name)
  ) {
    return fail(
      "The AI provider could not use that pair. Try a clear photo of one person and one visible garment.",
      422,
    );
  }
  return fail("The AI provider could not finish this fitting.", 502);
}

export async function handleStudioAi(request, env = {}, transport = fetch) {
  const url = new URL(request.url);
  const ticket = url.searchParams.get("job");
  if (/^(true|1)$/i.test(String(env.DRAPE_LOCAL_ONLY ?? ""))) {
    if (request.method === "GET" && !ticket)
      return json({ configured: false, mode: "local-only" });
    return fail("This studio uses on-device fitting only.", 403);
  }
  const { base, provider, providerId, model, secret } = configuration(env);
  if (request.method === "GET" && !ticket) {
    if (!secret && !env.DRAPE_RENDER_URL && !env.DRAPE_RENDER_TOKEN) {
      return json({
        providerId: "weshop-trial",
        provider: "WeShopAI’s public Hugging Face trial",
        model: "WeShopAI Virtual Try-On",
        configured: true,
        mode: "public-trial",
      });
    }
    return json({
      providerId,
      provider,
      model,
      configured: Boolean(secret),
      mode: providerId === "studio" ? "self-hosted" : "managed",
    });
  }
  if (!["POST", "GET"].includes(request.method))
    return fail("Use GET or POST.", 405);
  if (!secret)
    return fail("This studio has no live AI render service connected.", 503);
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user)
    return fail("Sign in to the fitting room before generating a look.", 401);
  const headers = {
    Authorization: "Bearer " + secret,
    "Content-Type": "application/json",
  };
  try {
    if (request.method === "GET") {
      const id = await openTicket(ticket, user, secret);
      if (!id)
        return fail(
          "This fitting link has expired or belongs to another session.",
          404,
        );
      const reply = await transport(base + "/status/" + id, {
        headers,
        signal: AbortSignal.timeout(22000),
        redirect: "error",
      });
      const data = await limitedJson(reply, IMAGE_LIMIT + 4096);
      if (!reply.ok || !data || data.error)
        return providerFailure(reply.status, data?.error);
      if (data.status === "completed") {
        if (!jpeg(data.output?.[0]))
          return fail("The AI provider returned no usable image.", 502);
        return json({ status: "completed", image: data.output[0] });
      }
      if (["starting", "in_queue", "processing"].includes(data.status))
        return json({ status: data.status });
      return providerFailure(reply.status, data.error);
    }
    if (request.headers.get("origin") !== url.origin)
      return fail("Start this fitting in the studio.", 403);
    if (
      !/^application\/json(?:;|$)/i.test(
        request.headers.get("content-type") || "",
      )
    ) {
      return fail("Send the fitting as JSON.", 415);
    }
    const body = await limitedJson(request, INPUT_LIMIT);
    if (!body) return fail("Choose two smaller photos and try again.", 413);
    if (body.consent !== true)
      return fail(
        "Choose to send both images to the displayed AI service before generating.",
        400,
      );
    if (body.providerId !== providerId)
      return fail(
        "The studio’s AI provider changed. Reopen the fitting dialog to review where your photos will go.",
        409,
      );
    if (!jpeg(body.person) || !jpeg(body.garment))
      return fail("Choose a model photo and a garment photo.", 422);
    if (
      !Object.hasOwn(categories, body.category) ||
      !["flat-lay", "model"].includes(body.garmentPhotoType)
    ) {
      return fail("Choose a garment type and photo style.", 422);
    }
    const sourceDescription =
      body.garmentPhotoType === "model"
        ? "Use only the target garment from the product reference, leaving its original model and styling behind."
        : "Use the garment from the standalone product reference.";
    const prompt = [
      "Dress the person in the " +
        categories[body.category] +
        " from the product photo.",
      sourceDescription,
      "Preserve the person's identity, build, pose, skin, hair, hands, background, lighting and framing.",
      "Match the product's colors, cut, seams, print, closures, texture and sleeve and hem proportions.",
      "Let the fabric wrap the body with natural tension, shadows and folds. Respect hands and hair in front of the fabric.",
      "Keep unrelated clothing and accessories.",
    ].join(" ");
    const payload =
      providerId === "studio"
        ? {
            person: body.person,
            garment: body.garment,
            category: body.category,
            garmentPhotoType: body.garmentPhotoType,
          }
        : {
            model_name: "tryon-max",
            inputs: {
              model_image: body.person,
              product_image: body.garment,
              prompt,
              generation_mode: "quality",
              resolution: "1k",
              num_images: 1,
              output_format: "jpeg",
              return_base64: true,
            },
          };
    const reply = await transport(base + "/run", {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(26000),
      body: JSON.stringify(payload),
    });
    const data = await limitedJson(reply, 32 * 1024);
    if (!reply.ok || data?.error)
      return providerFailure(reply.status, data?.error);
    if (
      typeof data?.id !== "string" ||
      !/^[A-Za-z0-9_-]{3,120}$/.test(data.id)
    ) {
      return fail(
        "The AI provider did not confirm a job. Check the provider history before resubmitting.",
        502,
      );
    }
    return json(
      { status: "submitted", job: await ticketFor(user, data.id, secret) },
      202,
    );
  } catch {
    return fail(
      request.method === "POST"
        ? "The AI provider did not confirm submission. Check its job history before trying again."
        : "The studio could not reach the AI provider to check this fitting.",
      502,
    );
  }
}
