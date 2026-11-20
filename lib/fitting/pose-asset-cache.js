// Only the fixed, redistributable model files use persistent browser storage.
// A blocked service worker must never prevent the fitting room from starting.
const script = "/drape-pose-cache.js?version=e0f75cd069ef";
let started;

async function registerCache(service) {
  const existing = await service.getRegistration("/");
  const worker = existing?.active || existing?.waiting || existing?.installing;
  const expected = new URL(script, window.location.origin).href;
  if (worker && new URL(worker.scriptURL).pathname !== new URL(expected).pathname) return;
  if (worker?.scriptURL !== expected) await service.register(script, { scope: "/" });
  if (service.controller?.scriptURL === expected) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      service.removeEventListener("controllerchange", check);
      resolve();
    };
    const check = () => {
      if (service.controller?.scriptURL === expected) finish();
    };
    const timer = setTimeout(finish, 1000);
    service.addEventListener("controllerchange", check);
    check();
  });
}

export function enablePoseAssetCache() {
  if (typeof window === "undefined" || !window.isSecureContext) return;
  try {
    const service = window.navigator.serviceWorker;
    if (!service) return;
    if (!started) {
      // First-run registration may be slow or unavailable in a private webview.
      // The fitting also works with the ordinary HTTP cache.
      started = new Promise((resolve) => {
        const timer = setTimeout(resolve, 1100);
        registerCache(service).catch(() => {}).finally(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return started;
  } catch {
    // Some private or embedded browsing modes deny service-worker access.
  }
}
