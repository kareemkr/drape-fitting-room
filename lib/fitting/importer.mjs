import { retailerSizing } from "./retailer-sizes.mjs";
const MAX_HTML = 2 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BLOCKED_SUFFIXES =
  /(?:^|\.)(?:localhost|local|internal|lan|home|onion|test|example|invalid|arpa)$/i;
const FALLBACK = "You can upload a saved product photo instead.";

class ImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function publicUrl(value, self, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    /* invalid input */
  }
  const host = url?.hostname.toLowerCase().replace(/\.$/, "") || "";
  if (
    !url ||
    !value ||
    url.href.length > 8192 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(
      host,
    ) ||
    BLOCKED_SUFFIXES.test(host) ||
    host === self
  ) {
    throw new ImportError(400, "Enter a public HTTPS product or image link.");
  }
  url.hostname = host;
  url.hash = "";
  return url;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function fetchRemote(input, self, signal, fetchPublic, imageOnly) {
  let current = input;
  for (let hop = 0; hop <= 4; hop++) {
    const response = await fetchPublic(current.href, {
      method: "GET",
      redirect: "manual",
      signal,
      credentials: "omit",
      headers: {
        accept: imageOnly
          ? "image/avif,image/webp,image/png,image/jpeg,image/gif"
          : "text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8",
      },
    });
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hop === 4)
        throw new ImportError(
          422,
          "This link redirects too many times. Paste the final product URL.",
        );
      current = publicUrl(location, self, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ImportError(
        422,
        "The shop could not provide that page or image. " + FALLBACK,
      );
    }
    return { response, current };
  }
}

// Read just the useful prefix for markup and header checks. Never buffer an unbounded image.
async function bytes(response, max, prefix = false) {
  if (!response.body)
    throw new ImportError(
      422,
      "The shop returned an empty response. " + FALLBACK,
    );
  if (!prefix && Number(response.headers.get("content-length")) > max) {
    await response.body.cancel();
    throw new ImportError(
      413,
      "The product image exceeds 8 MB. Choose a smaller version.",
    );
  }
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length > max - total && !prefix) {
        await reader.cancel();
        throw new ImportError(
          413,
          "The product image exceeds 8 MB. Choose a smaller version.",
        );
      }
      const part = value.subarray(0, max - total);
      parts.push(part);
      total += part.length;
      if (prefix && total >= max) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function imageType(b) {
  const ascii = (i, j) => String.fromCharCode(...b.subarray(i, j));
  if (
    b.length >= 8 &&
    b[0] === 137 &&
    ascii(1, 4) === "PNG" &&
    b[4] === 13 &&
    b[5] === 10 &&
    b[6] === 26 &&
    b[7] === 10
  )
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") {
    for (let n = 8; n + 4 <= Math.min(64, b.length); n += 4) {
      if (n !== 12 && ["avif", "avis"].includes(ascii(n, n + 4)))
        return "image/avif";
    }
  }
  return "";
}

const ENTITIES = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
};
function unescapeHtml(value) {
  return String(value || "").replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (raw, entity) => {
      if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? raw;
      const hex = entity[1].toLowerCase() === "x";
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    },
  );
}

function label(v, limit) {
  if (typeof v !== "string") return "";
  return unescapeHtml(v)
    .replace(/<[^>]{0,500}>/g, "")
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .trim()
    .slice(0, limit);
}

function attrs(tag) {
  const result = Object.create(null);
  const pattern = /([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    result[match[1].toLowerCase()] = unescapeHtml(
      match[2] ?? match[3] ?? match[4],
    );
  }
  return result;
}

function structuredProducts(markup) {
  const products = [];
  for (const match of markup.matchAll(
    /<script\b([^>]{0,4096})>([\s\S]*?)<\/script\s*>/gi,
  )) {
    if (
      attrs(match[1]).type?.split(";")[0].trim().toLowerCase() !==
        "application/ld+json" ||
      match[2].length > 512000
    )
      continue;
    try {
      const pending = [JSON.parse(match[2].trim())];
      let visited = 0;
      while (pending.length && visited++ < 1024 && products.length < 24) {
        const item = pending.pop();
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item)) {
          pending.push(...item.slice(0, 128).reverse());
          continue;
        }
        if (
          [item["@type"]]
            .flat()
            .some((t) => /(?:^|[/#])Product(?:Group)?$/i.test(t))
        )
          products.push(item);
        for (const field of [
          "@graph",
          "mainEntity",
          "hasVariant",
          "isVariantOf",
        ]) {
          if (item[field]) pending.push(item[field]);
        }
      }
    } catch {
      /* Other metadata can still identify the product. */
    }
  }
  return products;
}

function imageCandidates(image) {
  return [image]
    .flat()
    .slice(0, 20)
    .flatMap((entry) =>
      typeof entry === "string"
        ? [entry]
        : [entry?.contentUrl, entry?.url, entry?.thumbnailUrl, entry?.["@id"]],
    );
}

function sourceName(url) {
  return url.hostname.replace(/^www\./i, "");
}

function listedProductPhotos(markup, name) {
  const normalize = (value) =>
    (value || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const title = normalize(name);
  if (title.length < 5) return [];
  const photos = [];
  let scanned = 0;
  for (const match of markup.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    if (++scanned > 400 || photos.length >= 30) break;
    const a = attrs(match[0]);
    if (!normalize(a.alt).includes(title)) continue;
    const image = a["data-zoom-src"] || a["data-src"] || a.src;
    if (image && !photos.includes(image)) photos.push(image);
  }
  return photos;
}

function choosePhotos(candidates, page, self) {
  const choices = new Map();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      const resolved = publicUrl(
        candidate.trim().replace(/^http:\/\//i, "https://"),
        self,
        page,
      );
      if (/\.svgz?$/i.test(resolved.pathname)) continue;
      const key = new URL(resolved);
      // Group different thumbnail sizes of one scene, keeping the rendition closest to 1200px.
      const width = Number(
        key.searchParams.get("width") || key.searchParams.get("w"),
      );
      for (const param of ["width", "height", "w", "h", "dpr"]) {
        if (/^\d+(?:\.\d+)?$/.test(key.searchParams.get(param) || ""))
          key.searchParams.delete(param);
      }
      const score = width > 0 ? Math.abs(Math.log(width / 1200)) : 0.3;
      const previous = choices.get(key.href);
      if (previous ? score < previous.score : choices.size < 5) {
        choices.set(key.href, { score, path: proxyPath(resolved) });
      }
    } catch {
      /* Try another image published by the shop. */
    }
  }
  return Array.from(choices.values(), (item) => item.path);
}

function productInfo(html, page, self) {
  const products = structuredProducts(html);
  const head = html.split(/<\/head\s*>/i, 1)[0].replace(/<!--[\s\S]*?-->/g, "");
  const meta = new Map();
  const imageMeta = new Map();
  const imageKeys = [
    "og:image:secure_url",
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
    "image",
    "image_src",
  ];
  for (const match of head.matchAll(
    /<(?:meta|link)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
  )) {
    const a = attrs(match[0]);
    const key = (
      a.property ||
      a.name ||
      a.itemprop ||
      a.rel ||
      ""
    ).toLowerCase();
    const value = a.content || a.href;
    if (!key || !value) continue;
    if (!meta.has(key)) meta.set(key, value);
    if (imageKeys.includes(key)) {
      if (!imageMeta.has(key)) imageMeta.set(key, []);
      if (imageMeta.get(key).length < 20) imageMeta.get(key).push(value);
    }
  }
  const product = products.find((p) => p.image) || products[0] || {};
  const title = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const name =
    label(product.name, 130) ||
    label(meta.get("og:title") || meta.get("twitter:title") || title, 130);
  const candidates = [
    ...imageCandidates(product.image),
    ...imageKeys.flatMap((key) => imageMeta.get(key) || []),
    ...listedProductPhotos(html, name),
  ];
  const images = choosePhotos(candidates, page, self);
  if (!images.length)
    throw new ImportError(
      422,
      "There’s no usable product photo on this page. " + FALLBACK,
    );
  const brand = [product.brand].flat()[0];
  return {
    name: name || "Imported garment",
    brand:
      label(typeof brand === "string" ? brand : brand?.name, 80) ||
      label(meta.get("product:brand") || meta.get("og:site_name"), 80) ||
      sourceName(page),
    image: images[0],
    images,
    ...retailerSizing(html, product, products, page, { label, attrs }),
  };
}

function proxyPath(url) {
  return "/api/product-image?url=" + encodeURIComponent(url.href);
}

async function serve(request, fetchPublic, imageOnly) {
  if (request.method !== "GET")
    return json({ error: "Use GET for this endpoint." }, 405);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return json({ error: "Open this feature in the fitting room." }, 403);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const cancel = () => controller.abort();
  request.signal?.addEventListener("abort", cancel, { once: true });
  if (request.signal?.aborted) cancel();
  try {
    const endpoint = new URL(request.url);
    const self = endpoint.hostname.toLowerCase().replace(/\.$/, "");
    const target = publicUrl(endpoint.searchParams.get("url"), self);
    const { response, current } = await fetchRemote(
      target,
      self,
      controller.signal,
      fetchPublic,
      imageOnly,
    );
    const declared = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const maybeImage =
      IMAGE_TYPES.has(declared) ||
      declared === "application/octet-stream" ||
      (!declared && /\.(?:jpe?g|png|webp|gif|avif)$/i.test(current.pathname));
    if (imageOnly || maybeImage) {
      if (!maybeImage) {
        await response.body?.cancel();
        throw new ImportError(
          422,
          "Use a JPG, PNG, WebP, GIF, or AVIF product photo.",
        );
      }
      const data = await bytes(
        response,
        imageOnly ? MAX_IMAGE : 256,
        !imageOnly,
      );
      const type = imageType(data);
      if (!type)
        throw new ImportError(
          422,
          "This link doesn’t contain a supported product image. " + FALLBACK,
        );
      if (imageOnly) {
        return new Response(data, {
          headers: {
            "content-type": type,
            "cache-control": "private, max-age=900",
            "x-content-type-options": "nosniff",
            "cross-origin-resource-policy": "same-origin",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      }
      const image = proxyPath(current);
      return json({
        name: "Imported garment",
        brand: sourceName(current),
        image,
        images: [image],
      });
    }
    if (
      declared &&
      !["text/html", "application/xhtml+xml"].includes(declared)
    ) {
      await response.body?.cancel();
      throw new ImportError(
        422,
        "Use a product page or a JPG, PNG, WebP, GIF, or AVIF image link.",
      );
    }
    const markup = new TextDecoder().decode(
      await bytes(response, MAX_HTML, true),
    );
    return json(productInfo(markup, current, self));
  } catch (err) {
    if (err instanceof ImportError)
      return json({ error: err.message }, err.status);
    if (controller.signal.aborted)
      return json(
        {
          error:
            "The shop took too long to respond. Try again or upload its product photo.",
        },
        504,
      );
    return json(
      {
        error:
          "The shop could not be reached. Check the link or upload a saved photo.",
      },
      502,
    );
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", cancel);
  }
}

export const handleImport = (request, fetchPublic = globalThis.fetch) =>
  serve(request, fetchPublic, false);
export const handleProductImage = (request, fetchPublic = globalThis.fetch) =>
  serve(request, fetchPublic, true);
