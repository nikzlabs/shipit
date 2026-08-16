#!/usr/bin/env node
/**
 * Measure what a page costs the renderer main thread while it is idle.
 *
 * Written for docs/265's "continuous idle compositing" finding: a page with an
 * always-on CSS animation produces a compositor frame every vsync, and *if the
 * document has any live IntersectionObserver* every one of those frames also
 * drags a full main-thread rendering lifecycle behind it. This script is how
 * that was attributed, and it is the tool for the follow-up left open in
 * `docs/265-transcript-render-cost/checklist.md`.
 *
 * It launches the Playwright chromium over CDP, records a DevTools trace for a
 * fixed window *after* the page has settled, and reports the two numbers that
 * distinguish "the compositor is busy" (cheap) from "the main thread is busy"
 * (not cheap):
 *
 *   drawFramesPerSecond            — frames the compositor produced
 *   beginMainThreadFramesPerSecond — frames that also ran the main-thread lifecycle
 *
 * A composited animation shows a high draw rate and a near-zero main-frame
 * rate. Anything else means something is forcing the main thread awake.
 *
 * Usage:
 *   node scripts/trace-idle-frames.mjs <url> [seconds] [options]
 *
 *   --settle=<ms>    wait this long after load before recording (default 3000)
 *   --eval=<file>    run this script in the page before settling; its resolved
 *                    value is printed to stderr (use to inject a probe element
 *                    or mutate the page into the condition under test)
 *   --init=<file>    run this script before ANY page script (CDP
 *                    addScriptToEvaluateOnNewDocument) — the only way to
 *                    intercept observers the app creates during boot
 *   --json=<file>    dump the report plus every raw trace event
 *
 * Note on numbers: a container with no GPU rasterises in software, so absolute
 * milliseconds are not a user's machine. Ratios between conditions are the
 * point — always measure A and B the same way, in the same run.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH
  ?? "/opt/playwright-browsers/chromium-1237/chrome-linux64/chrome";

const args = process.argv.slice(2);
const url = args[0];
const seconds = Number(args[1] ?? 10);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const settleMs = Number(flag("settle", 3000));
const jsonOut = flag("json", null);
const evalFile = flag("eval", null);
const initFile = flag("init", null);

if (!url || !Number.isFinite(seconds)) {
  console.error("usage: trace-idle-frames.mjs <url> [seconds] [--settle=ms] [--eval=f] [--init=f] [--json=f]");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-idle-"));

// `detached` so the whole browser process group can be killed at the end.
// Killing only the parent leaves every renderer behind as a zombie, and a few
// hundred of those exhaust the container's pid cgroup mid-run.
const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--window-size=1440,900",
  // Frame production has to stay realistic, or an idle page measures as idle
  // for the wrong reason.
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"], detached: true });

const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("chrome printed no devtools endpoint")), 30000);
  chrome.stderr.on("data", (buf) => {
    const m = /ws:\/\/[^\s]+/.exec(buf.toString());
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  });
});

/** Minimal CDP client over Node's global WebSocket — no dependencies. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
}

const socket = await new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => resolve(ws);
  ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? e}`));
});
const browser = new Cdp(socket);

const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
const send = (method, params) => browser.send(method, params, sessionId);

await send("Page.enable");
await send("Runtime.enable");

if (initFile) {
  await send("Page.addScriptToEvaluateOnNewDocument", { source: fs.readFileSync(initFile, "utf8") });
}

const loaded = new Promise((resolve) => browser.on("Page.loadEventFired", resolve));
await send("Page.navigate", { url });
await Promise.race([loaded, sleep(30000)]);

if (evalFile) {
  const result = await send("Runtime.evaluate", {
    expression: fs.readFileSync(evalFile, "utf8"),
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) console.error("eval threw:", JSON.stringify(result.exceptionDetails).slice(0, 600));
  else if (result.result?.value !== undefined) console.error("eval →", JSON.stringify(result.result.value).slice(0, 900));
}

// Settle first: startup work is not the steady-state cost we are after.
await sleep(settleMs);

const events = [];
browser.on("Tracing.dataCollected", (p) => events.push(...p.value));
const tracingComplete = new Promise((resolve) => browser.on("Tracing.tracingComplete", resolve));

await browser.send("Tracing.start", {
  transferMode: "ReportEvents",
  traceConfig: {
    recordMode: "recordAsMuchAsPossible",
    includedCategories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "blink",
      "blink.animations",
      "cc",
      "toplevel",
    ],
  },
});

await sleep(seconds * 1000);
await browser.send("Tracing.end");
await Promise.race([tracingComplete, sleep(60000)]);

// ── aggregate ────────────────────────────────────────────────────────────────
// Pick the renderer main thread by NAME. Picking "the busiest thread" selects
// the browser process on a genuinely idle page, which is how an idle page first
// measured as costing nothing.
const threadNames = new Map();
for (const e of events) {
  if (e.ph === "M" && e.name === "thread_name") threadNames.set(`${e.pid}:${e.tid}`, e.args?.name);
}
const lifecycleWeight = new Map();
for (const e of events) {
  if (e.ph !== "X") continue;
  if (e.name !== "Commit" && e.name !== "UpdateLayoutTree" && e.name !== "PrePaint") continue;
  const key = `${e.pid}:${e.tid}`;
  lifecycleWeight.set(key, (lifecycleWeight.get(key) ?? 0) + 1);
}
let mainKey = null;
let best = -1;
for (const [key, n] of lifecycleWeight) {
  if (threadNames.get(key) !== "CrRendererMain") continue;
  if (n > best) { best = n; mainKey = key; }
}
if (!mainKey) {
  for (const [key, name] of threadNames) if (name === "CrRendererMain") { mainKey = key; break; }
}
const mainPid = mainKey ? Number(mainKey.split(":")[0]) : null;

let mainBusyUs = 0;
for (const e of events) {
  if (e.ph === "X" && e.name === "RunTask" && `${e.pid}:${e.tid}` === mainKey) mainBusyUs += e.dur ?? 0;
}

// Fold rather than spread: a 10 s trace of a real app is hundreds of thousands
// of events, and `Math.min(...arr)` overflows the stack well before that.
let traceStart = Infinity;
let traceEnd = -Infinity;
for (const e of events) {
  if (!e.ts) continue;
  if (e.ts < traceStart) traceStart = e.ts;
  const end = e.ts + (e.dur ?? 0);
  if (end > traceEnd) traceEnd = end;
}
const windowSeconds = (traceEnd - traceStart) / 1e6;

const REPORTED = [
  "Layerize",
  "Commit",
  "UpdateLayoutTree",
  "PrePaint",
  "Paint",
  "Layout",
  "IntersectionObserverController::computeIntersections",
  "PageAnimator::serviceScriptedAnimations",
  "UpdateLayer",
  "FunctionCall",
  "TimerFire",
  "EventDispatch",
  "ParseHTML",
];

const totals = new Map();
for (const e of events) {
  if (e.ph !== "X" || `${e.pid}:${e.tid}` !== mainKey) continue;
  if (!REPORTED.includes(e.name)) continue;
  const t = totals.get(e.name) ?? { ms: 0, n: 0 };
  t.ms += (e.dur ?? 0) / 1000;
  t.n++;
  totals.set(e.name, t);
}

let drawFrames = 0;
let mainFrames = 0;
for (const e of events) {
  if (e.name === "DrawFrame") drawFrames++;
  else if (e.name === "BeginMainThreadFrame" && e.pid === mainPid) mainFrames++;
}

const report = {
  url,
  windowSeconds: +windowSeconds.toFixed(2),
  drawFramesPerSecond: +(drawFrames / windowSeconds).toFixed(1),
  beginMainThreadFramesPerSecond: +(mainFrames / windowSeconds).toFixed(1),
  mainThreadBusyMs: +(mainBusyUs / 1000).toFixed(1),
  mainThreadBusyPerSecondMs: +(mainBusyUs / 1000 / windowSeconds).toFixed(1),
  events: Object.fromEntries(
    [...totals.entries()]
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([k, v]) => [k, { totalMs: +v.ms.toFixed(1), calls: v.n, msPerCall: +(v.ms / v.n).toFixed(4) }]),
  ),
};

console.log(JSON.stringify(report, null, 2));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ report, rawEvents: events }));

try {
  process.kill(-chrome.pid, "SIGKILL");
} catch {
  chrome.kill("SIGKILL");
}
await new Promise((resolve) => {
  chrome.on("exit", resolve);
  setTimeout(resolve, 3000);
});
fs.rmSync(userDataDir, { recursive: true, force: true });
process.exit(0);
