#!/usr/bin/env node
import { buildReport, bumpCounter } from "../lib/report.mjs";

if (process.argv.includes("--bump")) {
  bumpCounter("cli");
}
const report = buildReport("cli");

if (process.argv.includes("--host-check")) {
  report.hostCheck = await checkDeclaredHost("https://example.com");
}

console.log(JSON.stringify(report, null, 2));

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
