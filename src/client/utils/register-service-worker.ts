/*
 * Registers the PWA service worker so ShipIt is installable and runs standalone
 * (no address bar) on mobile. The worker itself caches nothing (see
 * public/service-worker.js) — this is purely about installability.
 *
 * "Always latest" is preserved by the existing build-id reload (useServerEvents)
 * plus `Cache-Control: no-store` on the shell, so we additionally tell the
 * browser to bypass its HTTP cache when checking the worker script for updates
 * (`updateViaCache: "none"`) and proactively kick an update check on every load.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;

  window.addEventListener("load", () => {
    void (async () => {
      if (!navigator.serviceWorker) return;
      try {
        const registration = await navigator.serviceWorker.register("/service-worker.js", {
          scope: "/",
          updateViaCache: "none",
        });
        // Catch a worker that was updated while the app was already open.
        await registration.update();
      } catch {
        // A failed registration must never break the app — it just means no
        // standalone install on this load. Swallow silently.
      }
    })();
  });
}
