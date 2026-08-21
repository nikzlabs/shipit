// docs/262 — the test plugin's one service (`probe` in the compose fragment).
// A dependency-free HTTP server that renders the probe report from the
// service surface: /project mount, shared state dir, settings file, env.
//
//   GET  /             HTML report (reads never mutate the counter)
//   GET  /report.json  the raw report
//   POST /increment    bump the shared counter (what `probe --bump` also bumps)
//
// The page also exercises the Agent Interface SDK (req 3, plan §5): it awaits
// `window.shipit.ready`, feature-detects `embedded` (presence alone proves
// nothing — /shipit-docs/agent-interface-sdk.md), and a button sends the
// current counter to the agent via `window.shipit.agent.sendMessage()` — the
// real-instance E2E's browser-to-agent click.

import http from "node:http";
import { buildReport, bumpCounter } from "../lib/report.mjs";

const PORT = Number(process.env.PROBE_PORT) || 4820;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/report.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(buildReport("service"), null, 2));
    return;
  }
  if (req.method === "POST" && req.url === "/increment") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ counter: bumpCounter("service") }));
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
   <span class="ok" hidden id="hint">now run <code>probe --bump</code> — the CLI bumps the same counter</span></p>
<p>Agent Interface SDK: <b id="shipit">checking…</b>
   <button id="send" disabled>Send counter to agent</button>
   <span id="sent"></span></p>
<pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>
<script>
  document.getElementById("bump").addEventListener("click", async () => {
    const res = await fetch("/increment", { method: "POST" });
    const body = await res.json();
    document.getElementById("counter").textContent = body.counter ?? "—";
    document.getElementById("hint").hidden = false;
  });

  // req 3 — the browser-to-agent path. Presence alone proves nothing: await
  // the parent handshake and feature-detect "embedded" (agent-interface-sdk).
  (async () => {
    const label = document.getElementById("shipit");
    if (!window.shipit) { label.textContent = "absent"; return; }
    await window.shipit.ready;
    if (!window.shipit.embedded) { label.textContent = "injected, not embedded"; return; }
    label.textContent = "embedded";
    const send = document.getElementById("send");
    send.disabled = false;
    send.addEventListener("click", async () => {
      const sent = document.getElementById("sent");
      try {
        const counter = document.getElementById("counter").textContent;
        await window.shipit.agent.sendMessage({
          text: "test-plugin probe: the shared counter is " + counter +
            ". Reply with the counter value to confirm the plugin page reached you.",
        });
        sent.textContent = "sent — check the chat";
        sent.className = "ok";
      } catch (err) {
        sent.textContent = err instanceof Error ? err.message : "send failed";
        sent.className = "bad";
      }
    });
  })();
</script>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
