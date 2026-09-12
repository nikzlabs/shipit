#!/usr/bin/env node
/** Measure renderer main-thread work during an idle trace window. */

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
// Viewport size affects the number of visible composited layers.
const windowSize = flag("window", "1440,900");

if (!url || !Number.isFinite(seconds)) {
  console.error("usage: trace-idle-frames.mjs <url> [seconds] [--settle=ms] [--eval=f] [--init=f] [--json=f]");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-idle-"));

// Detach so cleanup can kill the complete browser process group.
const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  `--window-size=${windowSize}`,
  // Keep background frame production realistic.
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

// Choose the renderer main thread with the most lifecycle events.
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

// Use this renderer's event span and fold to avoid argument-stack overflow.
let traceStart = Infinity;
let traceEnd = -Infinity;
for (const e of events) {
  if (!e.ts) continue;
  const onMainThread = `${e.pid}:${e.tid}` === mainKey && e.ph === "X";
  const isFrame = e.pid === mainPid && (e.name === "DrawFrame" || e.name === "BeginMainThreadFrame");
  if (!onMainThread && !isFrame) continue;
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

// Scope both frame counts to the selected renderer process.
let drawFrames = 0;
let mainFrames = 0;
for (const e of events) {
  if (e.pid !== mainPid) continue;
  if (e.name === "DrawFrame") drawFrames++;
  else if (e.name === "BeginMainThreadFrame") mainFrames++;
}

const report = {
  url,
  windowSeconds: +windowSeconds.toFixed(2),
  drawFramesPerSecond: +(drawFrames / windowSeconds).toFixed(1),
  beginMainThreadFramesPerSecond: +(mainFrames / windowSeconds).toFixed(1),
  mainThreadBusyMs: +(mainBusyUs / 1000).toFixed(1),
  mainThreadBusyPerSecondMs: +(mainBusyUs / 1000 / windowSeconds).toFixed(1),
  updateLayerPerFrame: mainFrames
    ? +((totals.get("UpdateLayer")?.n ?? 0) / mainFrames).toFixed(2)
    : null,
  events: Object.fromEntries(
    [...totals.entries()]
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([k, v]) => [k, { totalMs: +v.ms.toFixed(1), calls: v.n, msPerCall: +(v.ms / v.n).toFixed(4) }]),
  ),
};

// Headless CDP does not emit LayerTree changes; trace events contain the counts.
const layerCounts = { visible: null, total: null };
for (const e of events) {
  if (e.pid !== mainPid) continue;
  const visible = e.args?.visible_layers;
  if (typeof visible === "number") layerCounts.visible = Math.max(layerCounts.visible ?? 0, visible);
  const total = e.args?.total_layer_count;
  if (typeof total === "number") layerCounts.total = Math.max(layerCounts.total ?? 0, total);
}
report.visibleLayers = layerCounts.visible;
report.totalLayers = layerCounts.total;

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
