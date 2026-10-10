#!/usr/bin/env node
import { createHash } from "node:crypto";
import { buildReport, bumpCounter } from "../lib/report.mjs";

// Only on request: a command that reads stdin to its end waits until the caller's stdin ends.
// Started first, so that its two times are when the input came and not when the probe got to it.
const stdin = process.argv.includes("--stdin") ? readStdin() : null;

if (process.argv.includes("--bump")) {
  bumpCounter("cli");
}
const report = buildReport("cli");

if (process.argv.includes("--host-check")) {
  report.hostCheck = await checkDeclaredHost("https://example.com");
}

if (stdin) {
  report.stdin = await stdin;
}

console.log(JSON.stringify(report, null, 2));

async function readStdin() {
  const hash = createHash("sha256");
  let bytes = 0;
  let firstByteAfterMs = null;
  try {
    for await (const chunk of process.stdin) {
      firstByteAfterMs ??= Math.round(performance.now());
      bytes += chunk.length;
      hash.update(chunk);
    }
  } catch (err) {
    return { bytes, firstByteAfterMs, error: String(err instanceof Error ? err.message : err) };
  }
  return { bytes, sha256: hash.digest("hex"), firstByteAfterMs, endAfterMs: Math.round(performance.now()) };
}

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
