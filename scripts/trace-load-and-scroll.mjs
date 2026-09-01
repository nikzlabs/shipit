#!/usr/bin/env node
/**
 * Measure what `content-visibility: auto` BUYS, as opposed to what it costs.
 *
 * `scripts/trace-idle-frames.mjs` measures the cost side of docs/265's
 * idle-compositing finding and deliberately starts tracing *after* load, so it
 * cannot see the two things `content-visibility: auto` exists for: skipping
 * layout and paint of off-screen rows at first render, and keeping a long
 * transcript cheap to scroll. This is the other half — the number the doc's
 * "The experiment that would settle it" asks for and nobody had.
 *
 * It traces from BEFORE navigation, reports the load-side totals, then drives a
 * scripted scroll from top to bottom and reports the same totals for that
 * window alone. Run the same URL with `cv=1` and `cv=0` and compare.
 *
 * Usage:
 *   node scripts/trace-load-and-scroll.mjs <url> [--scroll-ms=6000] [--window=w,h]
 *
 * Read `loadPhase` against `scrollPhase`: the load phase ends at the first
 * animation frame with no pending rendering work, so it covers parse, style,
 * first layout and first paint. The scroll phase is bounded by markers the
 * script emits itself (`console.timeStamp`), so trace-stop latency cannot leak
 * into it.
 *
 * Same caveat as the sibling script: no GPU in this container, so absolute
 * milliseconds are not a user's machine. Compare conditions measured the same
 * way in the same session.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH
  ?? "/opt/playwright-browsers/chromium-1237/chrome-linux64/chrome";

const args = process.argv.slice(2);
const url = args[0];
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const scrollMs = Number(flag("scroll-ms", 6000));
const windowSize = flag("window", "1440,900");
const jsonOut = flag("json", null);

if (!url) {
  console.error("usage: trace-load-and-scroll.mjs <url> [--scroll-ms=6000] [--window=w,h] [--json=f]");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-load-"));

const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  `--window-size=${windowSize}`,
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"], detached: true });

const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("chrome printed no devtools endpoint")), 30000);
  chrome.stderr.on("data", (buf) => {
    const m = /ws:\/\/[^\s]+/.exec(buf.toString());
    if (m) { clearTimeout(timer); resolve(m[0]); }
  });
});

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
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

const events = [];
browser.on("Tracing.dataCollected", (p) => events.push(...p.value));
const tracingComplete = new Promise((resolve) => browser.on("Tracing.tracingComplete", resolve));

// Tracing starts BEFORE navigation — that is the whole point of this script.
await browser.send("Tracing.start", {
  transferMode: "ReportEvents",
  traceConfig: {
    recordMode: "recordAsMuchAsPossible",
    includedCategories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "blink",
      "blink.user_timing",
      "toplevel",
    ],
  },
});

const loaded = new Promise((resolve) => browser.on("Page.loadEventFired", resolve));
await send("Page.navigate", { url });
await Promise.race([loaded, sleep(60000)]);

// The load phase ends when the page has nothing left to render. Two rAFs after
// load is the cheapest reliable "the first frame has been produced" signal.
await send("Runtime.evaluate", {
  expression: `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
    console.timeStamp("shipit-load-end");
    r(1);
  })))`,
  awaitPromise: true,
});

// Scripted scroll top → bottom. Stepping per animation frame keeps this at the
// browser's own cadence rather than a timer's, so the work measured is the work
// a user's scroll would cause.
await send("Runtime.evaluate", {
  expression: `(() => {
    console.timeStamp("shipit-scroll-start");
    const el = document.scrollingElement;
    const total = el.scrollHeight - el.clientHeight;
    const durationMs = ${scrollMs};
    const t0 = performance.now();
    return new Promise((resolve) => {
      function step() {
        const p = Math.min(1, (performance.now() - t0) / durationMs);
        el.scrollTop = total * p;
        if (p < 1) requestAnimationFrame(step);
        else requestAnimationFrame(() => {
          console.timeStamp("shipit-scroll-end");
          resolve({ total, finalTop: el.scrollTop });
        });
      }
      requestAnimationFrame(step);
    });
  })()`,
  awaitPromise: true,
  returnByValue: true,
});

await browser.send("Tracing.end");
await Promise.race([tracingComplete, sleep(60000)]);

// ── aggregate ────────────────────────────────────────────────────────────────
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
let mainKey = null, best = -1;
for (const [key, n] of lifecycleWeight) {
  if (threadNames.get(key) !== "CrRendererMain") continue;
  if (n > best) { best = n; mainKey = key; }
}

// Phase boundaries come from the markers the page emitted, so trace start/stop
// latency is outside every window reported below.
const marks = new Map();
for (const e of events) {
  const label = e.args?.data?.message ?? e.args?.message ?? e.name;
  if (typeof label === "string" && label.startsWith("shipit-")) marks.set(label, e.ts);
  // TimeStamp events carry the label under args.data.message on modern Chrome;
  // fall back to scanning any event whose name is the marker itself.
  if (e.name === "TimeStamp" && typeof e.args?.data?.message === "string") {
    marks.set(e.args.data.message, e.ts);
  }
}

let navStart = Infinity;
for (const e of events) {
  if (e.name === "navigationStart" || e.name === "ResourceSendRequest") navStart = Math.min(navStart, e.ts);
}
if (!Number.isFinite(navStart)) {
  for (const e of events) if (e.ts) navStart = Math.min(navStart, e.ts);
}

const REPORTED = [
  "Layout", "Paint", "UpdateLayoutTree", "PrePaint", "Commit", "Layerize",
  "ParseHTML", "FunctionCall", "EventDispatch",
  "IntersectionObserverController::computeIntersections",
];

function phase(fromTs, toTs) {
  let busyUs = 0;
  const totals = new Map();
  for (const e of events) {
    if (e.ph !== "X" || `${e.pid}:${e.tid}` !== mainKey) continue;
    if (e.ts < fromTs || e.ts > toTs) continue;
    if (e.name === "RunTask") busyUs += e.dur ?? 0;
    if (!REPORTED.includes(e.name)) continue;
    const t = totals.get(e.name) ?? { ms: 0, n: 0 };
    t.ms += (e.dur ?? 0) / 1000;
    t.n++;
    totals.set(e.name, t);
  }
  const named = Object.fromEntries(
    [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms)
      .map(([k, v]) => [k, { totalMs: +v.ms.toFixed(1), calls: v.n }]),
  );
  return {
    spanMs: +((toTs - fromTs) / 1000).toFixed(1),
    mainThreadBusyMs: +(busyUs / 1000).toFixed(1),
    layoutPlusPaintMs: +(((totals.get("Layout")?.ms ?? 0) + (totals.get("Paint")?.ms ?? 0)
      + (totals.get("UpdateLayoutTree")?.ms ?? 0)) / 1).toFixed(1),
    events: named,
  };
}

const loadEnd = marks.get("shipit-load-end");
const scrollStart = marks.get("shipit-scroll-start");
const scrollEnd = marks.get("shipit-scroll-end");

let firstPaintTs = Infinity;
for (const e of events) {
  if (`${e.pid}:${e.tid}` !== mainKey) continue;
  if (e.name === "firstContentfulPaint" || e.name === "firstPaint") firstPaintTs = Math.min(firstPaintTs, e.ts);
}

const report = {
  url,
  firstContentfulPaintMs: Number.isFinite(firstPaintTs) ? +((firstPaintTs - navStart) / 1000).toFixed(1) : null,
  loadPhase: loadEnd ? phase(navStart, loadEnd) : { error: "no shipit-load-end marker in trace" },
  scrollPhase: scrollStart && scrollEnd
    ? phase(scrollStart, scrollEnd)
    : { error: "no scroll markers in trace" },
};

console.log(JSON.stringify(report, null, 2));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ report, rawEvents: events }));

try { process.kill(-chrome.pid, "SIGKILL"); } catch { chrome.kill("SIGKILL"); }
await new Promise((resolve) => { chrome.on("exit", resolve); setTimeout(resolve, 3000); });
fs.rmSync(userDataDir, { recursive: true, force: true });
process.exit(0);
