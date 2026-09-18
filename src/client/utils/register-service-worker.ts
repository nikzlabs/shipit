

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

        await registration.update();
      } catch {
        // A failed registration must never break the app — it just means no

      }
    })();
  });
}
