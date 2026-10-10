#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildReport, bumpCounter, stateDir } from "../lib/report.mjs";

// Only on request: a command that reads stdin to its end waits until the caller's stdin ends.
// Started first, so that its two times are when the input came and not when the probe got to it.
const stdin = process.argv.includes("--stdin") ? readStdin() : null;

if (process.argv.includes("--bump")) {
  bumpCounter("cli");
}
// Only on request: this call then runs for that many seconds, unless something kills it.
const holdAt = process.argv.indexOf("--hold");
if (holdAt >= 0) {
  await hold(Number(process.argv[holdAt + 1]));
}
const report = buildReport("cli");
const lastHold = readLastHold();
if (lastHold) report.hold = lastHold;

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

function holdFile() {
  const dir = stateDir("cli");
  return dir ? path.join(dir, "hold.json") : null;
}

// Records how long it ran, so that a later call can say whether this one ended by itself or was killed.
async function hold(seconds) {
  const file = holdFile();
  if (!file || !(seconds > 0)) return;
  const startedAt = Date.now();
  const record = (finished) => {
    const next = { startedAt: new Date(startedAt).toISOString(), seconds, ranMs: Date.now() - startedAt, finished };
    // A rename, so that a kill at any moment leaves a complete record.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
    fs.renameSync(`${file}.tmp`, file);
  };
  record(false);
  while (Date.now() - startedAt < seconds * 1000) {
    await sleep(250);
    record(false);
  }
  record(true);
}

function readLastHold() {
  const file = holdFile();
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
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
