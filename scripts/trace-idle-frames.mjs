#!/usr/bin/env node
/**
 * Measure what a page costs the renderer main thread while it is idle.
 *
 * Written for docs/265's "continuous idle compositing" finding: an always-on CSS
 * animation makes the browser schedule a frame every vsync, and *if the document
 * has any live IntersectionObserver* every one of those frames also drags a
 * main-thread rendering pass behind it. This script is how that was attributed.
 * It measures the cost side only — the saving that `content-visibility: auto`
 * buys at load and on scroll needs different instrumentation, so this is not the
 * tool for the follow-up left open in
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
 * rate. Anything else means something is forcing the main thread awake. The two
 * are independent: an animating element scrolled out of view drives main frames
 * at display rate while the compositor draws nothing at all, so read the
 * main-frame rate as the cost and the draw rate only as evidence of what is
 * visible.
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
 *   --window=<w,h>   browser window size (default 1440,900)
 *   --json=<file>    dump the report plus every raw trace event
 *
 * `visibleLayers` / `totalLayers` / `updateLayerPerFrame` exist for docs/265's
 * remaining open question, which is about the size of the composited layer tree:
 * `Layerize` is `PaintArtifactCompositor::Update`, main-thread layer-list
 * construction from paint chunks, so its cost tracks how many layers there are
 * and not how they are rasterised. Production ShipIt runs ~29 layer updates per
 * frame and a 0.65 ms `Layerize`; everything measured here sits at ~0.03 and
 * ~0.0025 ms with a 3-4 layer tree.
 *
 * Note on numbers: a container with no GPU rasterises in software, so absolute
 * milliseconds are not a user's machine. Ratios between conditions are the
 * point — always measure A and B the same way, in the same run.
 *
 * Two reporting details, so nobody re-derives them from surprise. `windowSeconds`
 * spans this renderer's own main-thread work and frames, NOT every event in the
 * trace — see the comment on it for why that distinction was worth 1.35x. And
 * `mainThreadBusyPerSecondMs` is total `RunTask` time, which exceeds the sum of
 * the named events below it — the breakdown lists the rendering lifecycle, not
 * everything the thread did.
 *
 * One thing this measures that `steps()` does NOT fix: a stepped animation only
 * stops scheduling frames if it animates a COMPOSITOR-ONLY property. Stepping an
 * animation of `left`, or of `stroke-dashoffset` on an SVG, still wakes the main
 * thread every vsync — measured at 60 against 10 for the same steps() on
 * `transform`.
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
// Viewport is a real axis for layer-tree cost, not a cosmetic setting: more
// visible content means more composited layers to update per frame.
const windowSize = flag("window", "1440,900");

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
  `--window-size=${windowSize}`,
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
//
// Among threads named CrRendererMain, take the one running the most lifecycle
// events, falling back to the first. That is a heuristic for "the renderer whose
// page we navigated", and with several renderer processes in the trace (an
// iframe on its own site, say) the fallback picks arbitrarily.
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

// The window is the span of the work the rates are ABOUT — this renderer's main
// thread and its frames — not the span of every event in the trace.
//
// Spanning every event overstates it badly and silently: the browser process is
// already producing frames when tracing starts, and Perfetto's own flush runs
// after `Tracing.end`. An 8 s recording measured 10.77 s that way, so every
// per-second rate came out 1.35x too low and 60 Hz read as 44.7. Caught in
// review of the docs/265 animation work; numbers in that doc recorded BEFORE
// 2026-09-01 use the old denominator and are not comparable with later ones.
//
// Fold rather than spread: a 10 s trace of a real app is hundreds of thousands
// of events, and `Math.min(...arr)` overflows the stack well before that.
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

// Both frame counts are scoped to the renderer process, so the two rates are
// directly comparable. `DrawFrame` comes off that renderer's Compositor thread
// and `BeginMainThreadFrame` off its CrRendererMain — counting one globally and
// the other per-process would silently mix in the browser process's frames.
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

// Composited layer-tree size, read out of the trace rather than the CDP
// LayerTree domain: `LayerTree.enable` succeeds in headless but never emits a
// single `layerTreeDidChange`, so the domain is unusable here. cc annotates the
// counts on its own per-frame events instead, which costs nothing extra.
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
