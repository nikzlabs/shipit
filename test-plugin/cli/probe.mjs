#!/usr/bin/env node
// docs/262 — the test plugin's exported CLI (`probe` in the manifest's cli map).
// Prints the probe report as JSON. What runs in the AGENT container is only
// ShipIt's generated wrapper; this file runs in an invocation container that
// holds the plugin's tree at /plugin, the consuming project at /project (its
// cwd — req 21), this import's state dir, and the plugin's declared
// credentials, and nothing else (plan §2, "CLIs").
//
//   probe                 print the report (read-only — mutates nothing)
//   probe --bump          increment the shared counter first (reqs 17, 18),
//                         then report; the service page shows the same number
//   probe --host-check    additionally try HTTPS to the declared host
//                         (example.com, req 24) and report allowed/blocked
//
// Exit code is always 0 — the probe reports; it does not judge.

import { buildReport, bumpCounter } from "../lib/report.mjs";

if (process.argv.includes("--bump")) {
  bumpCounter("cli");
}
const report = buildReport("cli");

if (process.argv.includes("--host-check")) {
  report.hostCheck = await checkDeclaredHost("https://example.com");
}

console.log(JSON.stringify(report, null, 2));

/** req 24 — hosts are informational and grant nothing; this observes the
 * invocation container's actual egress for the one host the manifest
 * declares. */
async function checkDeclaredHost(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    return { url, allowed: true, status: res.status };
  } catch (err) {
    return { url, allowed: false, error: String(err instanceof Error ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}
