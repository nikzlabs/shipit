/**
 * Mobile-preview harness page server (docs/066).
 *
 * Serves a small responsive page that reports its own viewport and UA, so the
 * viewport-resize feature can be verified end-to-end against a real iframe:
 * the page's `window.innerWidth/innerHeight` must follow the chosen preset,
 * its CSS breakpoints must flip, and the UA must stay untouched. The page also
 * posts the injected preview script's `{source:"shipit-preview",
 * type:"loaded"}` message, so `PreviewFrame`'s auth-blocked detection (which
 * would otherwise overlay the page after ~5s) sees the load the way the
 * proxied injection reports it.
 *
 * Run: `npx tsx docs/066-mobile-preview/harness-server.ts` (listens on 8080),
 * then open `/docs/066-mobile-preview/harness.html` through the dev service.
 */

import http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Viewport harness page</title>
<style>
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #f5f0e6; color: #1c1917; }
  main { padding: 24px; }
  h1 { font-size: 18px; }
  #size { font-size: 32px; font-variant-numeric: tabular-nums; font-weight: 700; }
  .badges { display: flex; gap: 8px; margin: 16px 0; }
  .badge { padding: 2px 10px; border-radius: 999px; border: 1px solid currentColor; opacity: .35; }
  .badge.on { opacity: 1; background: #14532d; border-color: #14532d; color: #fff; }
  #ua { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
  @media (max-width: 639px)  { body { background: #e0f2fe; } }
  @media (min-width: 640px) and (max-width: 1023px) { body { background: #fef3c7; } }
  @media (min-width: 1024px) { body { background: #dcfce7; } }
</style>
</head>
<body>
<main>
  <h1>Viewport harness page</h1>
  <div id="size">—</div>
  <div class="badges">
    <span id="b-phone" class="badge">phone (&lt;640)</span>
    <span id="b-tablet" class="badge">tablet (640–1023)</span>
    <span id="b-desktop" class="badge">desktop (≥1024)</span>
  </div>
  <div id="ua">—</div>
</main>
<script>
  // The injected preview script's load signal, so PreviewFrame's auth-blocked
  // detection treats this page as a clean load.
  window.parent.postMessage({ source: "shipit-preview", type: "loaded" }, "*");
  function update() {
    document.getElementById("size").textContent =
      window.innerWidth + " × " + window.innerHeight;
    document.getElementById("b-phone").classList.toggle("on", window.innerWidth < 640);
    document.getElementById("b-tablet").classList.toggle("on", window.innerWidth >= 640 && window.innerWidth < 1024);
    document.getElementById("b-desktop").classList.toggle("on", window.innerWidth >= 1024);
  }
  document.getElementById("ua").textContent = navigator.userAgent;
  update();
  window.addEventListener("resize", update);
</script>
</body>
</html>`;

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`[mobile-preview harness] page http://127.0.0.1:${PORT}/`);
  });
