/**
 * Agent Interface SDK preview test service.
 *
 * Serves `index.html` — a page that reports the state of `window.shipit` and can
 * send a message to the session's agent — so the SDK can be exercised inside a
 * real ShipIt service preview. Run it as the `sdk-test` Compose service (see
 * docker-compose.yml) and open the preview.
 *
 * The page carries the shared bootstrap inline rather than waiting for the
 * preview proxy to inject it. `injectPreviewBootstrap` skips a response that
 * already contains the marker, so the page is byte-identical to what the proxy
 * would have added — and testing a bootstrap change does not require the
 * orchestrator serving the preview to be redeployed first.
 *
 * `--harness` additionally serves a stand-in ShipIt host on HARNESS_PORT that
 * embeds the page cross-origin (different port ⇒ different origin) and answers
 * the ready/visibility/agent_message protocol the way `PreviewFrame` does. That
 * is how the SDK is exercised in a plain browser, with no orchestrator running.
 */

import http from "node:http";
import fs from "node:fs";
import { AGENT_INTERFACE_SDK_SCRIPT } from "../src/server/shared/agent-interface-sdk/bootstrap.js";

const PORT = Number(process.env.PORT ?? 3002);
const HARNESS_PORT = Number(process.env.HARNESS_PORT ?? PORT + 1);
const withHarness = process.argv.includes("--harness");

const read = (name: string) => fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

function send(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

const pageServer = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  send(res, read("index.html").replace("<!--shipit-sdk-->", AGENT_INTERFACE_SDK_SCRIPT));
});
pageServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[sdk-test] page      http://127.0.0.1:${PORT}/`);
});

if (withHarness) {
  const harnessServer = http.createServer((_req, res) => send(res, read("harness.html")));
  harnessServer.listen(HARNESS_PORT, "127.0.0.1", () => {
    console.log(
      `[sdk-test] harness   http://127.0.0.1:${HARNESS_PORT}/?child=${
        encodeURIComponent(`http://localhost:${PORT}/`)
      }`,
    );
  });
}
