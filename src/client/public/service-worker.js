/*
 * ShipIt service worker — installability only, deliberately cache-free.
 *
 * A service worker exists for ONE reason here: it satisfies the browser's
 * installability criteria so ShipIt can be added to the home screen and run as
 * a standalone PWA (no Chrome address bar) on mobile. It is NOT here to cache
 * anything.
 *
 * ShipIt is a live, server-driven IDE — a stale shell or stale JS bundle served
 * from a cache would be actively harmful (the user would be talking to an old
 * client against a newer orchestrator). So this worker:
 *   - precaches nothing,
 *   - intercepts no responses (the `fetch` handler exists only because Chrome
 *     requires one for installability; it never calls `respondWith`, so every
 *     request goes straight to the network exactly as if no SW were present),
 *   - and on activation deletes any Cache Storage left behind by a previous
 *     version of this worker, so upgrading from a caching SW can't strand the
 *     user on old assets.
 *
 * Combined with `Cache-Control: no-store` on the HTML shell and this file
 * (see serveStaticClient in app-assembly.ts), the standalone app always boots
 * the latest code, just like a normal browser tab.
 */

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Purge anything a prior (possibly caching) worker version stored.
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

// Required for installability. No `respondWith` => pure pass-through to network.
self.addEventListener("fetch", () => {});
