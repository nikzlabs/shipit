// docs/262 — the test plugin's one service (`probe` in the compose fragment).
// A dependency-free HTTP server that renders the probe report from the
// service surface: /project mount, shared state dir, settings file, env.
//
//   GET  /             HTML report (auto-refreshes the counter line)
//   GET  /report.json  the raw report
//   POST /increment    bump the shared counter (what the CLI also bumps)
//
// The page also reports whether `window.shipit` is injected — the hook the
// real-instance E2E uses (plan §5).

import http from "node:http";
import { buildReport } from "../lib/report.mjs";

const PORT = Number(process.env.PROBE_PORT) || 4820;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/report.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(buildReport("service"), null, 2));
    return;
  }
  if (req.method === "POST" && req.url === "/increment") {
    const report = buildReport("service"); // building the report increments the counter
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ counter: report.state.counter ?? null }));
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderPage(buildReport("service")));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`test-plugin probe service listening on :${PORT}`);
});

function renderPage(report) {
  const greeting = report.settings.greeting ?? "(no settings file — default lives in the manifest)";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>test-plugin probe</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem;max-width:48rem}
  pre{background:#f4f4f4;padding:1rem;border-radius:6px;overflow:auto}
  .ok{color:#1a7f37}.bad{color:#b35900}
</style></head>
<body>
<h1>test-plugin probe — service surface</h1>
<p><b>${escapeHtml(greeting)}</b></p>
<p>Shared counter: <b id="counter">${report.state.counter ?? "—"}</b>
   <button id="bump">Increment</button>
   <span class="ok" hidden id="hint">now run the <code>probe</code> CLI — it bumps the same counter</span></p>
<p>window.shipit: <b id="shipit">checking…</b></p>
<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>
<script>
  document.getElementById("shipit").textContent = window.shipit ? "injected" : "absent";
  document.getElementById("bump").addEventListener("click", async () => {
    const res = await fetch("/increment", { method: "POST" });
    const body = await res.json();
    document.getElementById("counter").textContent = body.counter ?? "—";
    document.getElementById("hint").hidden = false;
  });
</script>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
