// Public model files only. Refresh the hashes and cache version when their bytes change.
const cachePrefix = "drape-pose-assets-";
const cacheName = cachePrefix + "e0f75cd069ef";
const files = new Map([
  ["/pose-assets/pose_landmarker_lite.task", "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"],
  ["/pose-assets/wasm/vision_wasm_internal.js", "4a97e2520ba506c680ecd6ba6acfb146888afa0e2746d57f205352bc6ebb82eb"],
  ["/pose-assets/wasm/vision_wasm_internal.wasm", "f00ec4731faa23b3e714d00e88d4d10e2df5c0a427d3a2b4ae6e3526fdd14ef7"],
  ["/pose-assets/wasm/vision_wasm_nosimd_internal.js", "927def7b465c51b86e4b3060f93646aca4e27121f4b8fc0483786e407ea9cf1f"],
  ["/pose-assets/wasm/vision_wasm_nosimd_internal.wasm", "3821ea9b1f7fb8c549ef2a064ef5c85750bf375c545a49fd6eea0df44a95f1f4"],
  ["/pose-cpu/group1-shard1of2.bin", "b42c3232bf13b0efc691d3f0693dd3fc74404f709b1deee0a271828af6dbbea2"],
  ["/pose-cpu/group1-shard2of2.bin", "8253ab965aa3122c08f331777ca395ce9ca19bb9e7cb278b99de1c46dbdeb6dc"],
  ["/pose-cpu/live-worker.js", "b2f8323acdd573c95b88eba980582f51b366d090dad369704cd06edca7ea5a38"],
  ["/pose-cpu/model.json", "c65a3447162efa0c42af29498a4b151f4415b36ff3ae6fae2b28a32e840dcbfb"],
  ["/pose-cpu/tfjs-backend-wasm-simd.wasm", "77ebb28a6d34f371dbbf2086b7f2de8994acd8ea5a3cf1fa24d2c26c840cac7b"],
  ["/pose-cpu/tfjs-backend-wasm.wasm", "70a5d516060464e5269f01c74bac1772d6b8ab6cb612acf16b5cdaf61f78d892"],
  ["/pose-cpu/worker.js", "315601e20dfa6d80c175119e502eb4df73eb81003ead01960b0a3720697667b6"],
]);

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((name) =>
        name.startsWith(cachePrefix) && name !== cacheName
      ).map((name) => caches.delete(name)));
    } catch {
      // Storage may be disabled; allow an ordinary network-backed fitting.
    }
    await self.clients.claim();
  })());
});

function assetType(path) {
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function readAsset(request, path, digest) {
  let cache;
  try {
    cache = await caches.open(cacheName);
    const stored = await cache.match(path);
    if (stored) return stored;
  } catch {
    // Quotas, storage eviction and restricted contexts fall back to HTTP.
    return fetch(request);
  }

  const response = await fetch(request);
  if (response.status !== 200 || response.redirected ||
      /no-store/i.test(response.headers.get("cache-control") || "")) return response;

  try {
    const bytes = await response.clone().arrayBuffer();
    const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(sum, (n) => n.toString(16).padStart(2, "0")).join("");
    if (hex === digest) {
      // Never retain authorization headers, sign-in pages or response metadata.
      await cache.put(path, new Response(bytes, {
        headers: { "Content-Type": assetType(path), "X-Content-Type-Options": "nosniff" },
      }));
    }
  } catch {
    // The original network response can still be used when persistence fails.
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode === "navigate" ||
      request.cache === "no-store" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search) return;
  const digest = files.get(url.pathname);
  if (digest) event.respondWith(readAsset(request, url.pathname, digest));
});
