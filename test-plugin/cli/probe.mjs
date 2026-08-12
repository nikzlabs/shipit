#!/usr/bin/env node
// docs/262 — the test plugin's exported CLI (`probe` in the manifest's cli map).
// Prints the probe report as JSON. Runs in the agent container with
// cwd = the consuming project's workspace (plan §2, req 21).
//
//   probe                 print the report
//   probe --host-check    additionally try HTTPS to the declared host
//                         (example.com, req 24) and report allowed/blocked
//
// Exit code is always 0 — the probe reports; it does not judge.

import { buildReport } from "../lib/report.mjs";

const report = buildReport("cli");

if (process.argv.includes("--host-check")) {
  report.hostCheck = await checkDeclaredHost("https://example.com");
}

console.log(JSON.stringify(report, null, 2));

/** req 24 — hosts are informational and grant nothing; this observes the
 * agent container's actual egress for the one host the manifest declares. */
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
