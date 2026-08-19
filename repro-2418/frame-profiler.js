/**
 * Frame profiler for nikzlabs/shipit#2418 — "Mobile Preview pane withholds
 * animation frames for seconds at a time".
 *
 * TEMPORARY. This whole directory is a reproduction harness, not part of ShipIt.
 * See README.md; it should be removed before the branch merges.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * The original report could show that the *page* was not at fault, but not what
 * was. Two host-side causes look identical from inside a cross-origin iframe —
 * the host blocking the shared main thread, and the browser throttling the
 * frame's rendering — and the report's instrumentation could not tell them
 * apart. This one can, from the phone, with no cooperation from ShipIt:
 *
 *   A TIMER HEARTBEAT next to the rAF loop. Render-throttling stops frames and
 *   leaves the event loop alone; a blocked main thread stops both. Measured on
 *   Chromium 141 with a phone-shaped viewport, over 9 induced stalls each:
 *
 *     host blocks its main thread   → 9 rAF stalls, 9 timer gaps (max 3004 ms)
 *     iframe scrolled out of view   → 9 rAF stalls, 0 timer gaps (max   19 ms)
 *     iframe set to display: none   → 9 rAF stalls, 0 timer gaps (max   19 ms)
 *     nothing (control)             → 0 rAF stalls, 0 timer gaps (max   19 ms)
 *
 * and the last two are separated by this page's own viewport: `display: none`
 * collapses it to 0×0, being scrolled out of view does not.
 *
 * So the verdict below is read off measured behaviour, not guessed.
 *
 * `window.shipit.visibility` is recorded too. On a ShipIt build carrying the fix
 * from PR #2459 its transitions should bracket the stalls; on a build without
 * it, it stays `true` throughout and the heartbeat carries the diagnosis alone.
 */
(() => {
  if (window.__shipitFrameProfiler) return;

  const STALL_MS = 100;          // a gap this long is not a slow frame
  const MAX_FRAMES = 20_000;     // ring cap; stalls are kept in full
  const BEAT_MS = 16;
  // Booting the game — compiling shaders, decoding ground textures, building the
  // world — blocks the main thread by design and for several seconds. Counting
  // that would hand back "the thread is blocked" on every run, which is true and
  // useless. Nothing before this mark is measured; the HUD says so while it waits.
  const WARMUP_MS = 6_000;
  // Unattended capture. The first phone run came back clean after 49 s of
  // someone watching the screen, and the reported bursts arrive minutes apart —
  // so the profiler sends the report itself the first time it sees a real burst,
  // and the phone can then just sit there with the tab open.
  const BURST_STALLS = 3;        // stalls…
  const BURST_WINDOW_MS = 20_000; // …inside this window is a burst, not a blip


  const state = {
    startedAt: performance.now(),
    // Wall clock as well as the monotonic one: the open question is what the
    // HOST was doing when frames stopped, and answering it means lining a burst
    // up against the session's own timeline.
    startedAtWall: new Date().toISOString(),
    frames: 0,
    intervals: [],               // recent frame intervals (ring)
    stalls: [],                  // { atMs, ms, periods, viewport, intersecting, shipitVisible }
    maxCallbackMs: 0,
    beats: 0,
    timerGaps: [],               // { atMs, ms }
    maxBeatMs: 0,
    longtasks: 0,
    loafs: 0,
    visibility: [],              // { atMs, visible } from window.shipit
    hiddenEver: false,
    heapValues: new Set(),
    // ShipIt stops correcting a scrolled-off shell while the focused element is
    // an iframe (useAppViewportHeight's `isFocusHoldingScroll`), and playing the
    // game is what focuses this one. `document.hasFocus()` inside the frame is
    // that exact condition seen from in here, so it is recorded per stall — if
    // stalls only ever happen with focus held, that is a real lead.
    firstTouchAtMs: null,
    touches: 0,
    firstFocusAtMs: null,
  };

  /**
   * The script is injected in `<head>` so that measurement starts before the
   * game's first frame — which means there is no `<body>` and no canvas yet.
   * Anything that touches the DOM waits; the counters above do not.
   */
  function whenDomReady(fn) {
    if (document.body) fn();
    else document.addEventListener("DOMContentLoaded", fn, { once: true });
  }

  // ── The page's own signals, the ones the original report relied on ─────────
  //
  // Watch the canvas the game DRAWS on, which is not simply the first one in the
  // document: the game's debug panel builds a 0×0 canvas inside an `<aside>`
  // that precedes it, and observing that reported "not intersecting" forever.
  // Largest area wins, re-checked until one has area, because at DOM-ready the
  // renderer has not sized anything yet.
  let intersecting = null;
  let observedCanvas = null;
  let observedLabel = null;
  function watchCanvas() {
    if (observedCanvas || warming() || !("IntersectionObserver" in window)) return;
    // Chosen at the END of warm-up, never before. Picking early is a race the
    // first attempt lost: the debug panel's minimap canvas had area while the
    // game's own `#view` was still 0×0, so the profiler watched a canvas that
    // sits off the right edge of a phone-width panel and reported "not
    // intersecting" for the whole run — which would have read as "the pane is
    // hidden". By the end of warm-up the renderer has sized everything.
    const byId = document.getElementById("view");
    const canvases = [...document.querySelectorAll("canvas")];
    const biggest = canvases
      .map((c) => ({ c, area: c.getBoundingClientRect().width * c.getBoundingClientRect().height }))
      .sort((a, b) => b.area - a.area)[0];
    const pick = byId instanceof HTMLCanvasElement ? byId : biggest?.c;
    if (!pick || pick.getBoundingClientRect().width === 0) return;
    observedCanvas = pick;
    observedLabel = pick.id ? `#${pick.id}` : `canvas in <${pick.parentElement?.tagName.toLowerCase()}>`;
    new IntersectionObserver((entries) => {
      intersecting = entries[entries.length - 1].isIntersecting;
    }).observe(observedCanvas);
  }

  observe("longtask", () => { state.longtasks++; });
  observe("long-animation-frame", () => { state.loafs++; });

  function observe(type, onEntry) {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) onEntry(e); })
        .observe(type === "longtask" ? { entryTypes: ["longtask"] } : { type, buffered: true });
    } catch { /* not supported here — recorded as 0, which the verdict allows for */ }
  }

  // ── What ShipIt tells the page ────────────────────────────────────────────
  let shipitVisible = null;
  const sdk = window.shipit;
  if (sdk?.visibility?.subscribe) {
    sdk.visibility.subscribe((visible) => {
      shipitVisible = visible;
      state.visibility.push({ atMs: Math.round(since()), visible });
    });
  }

  // ── The heartbeat. Not a frame — a task. ──────────────────────────────────
  let lastBeat = performance.now();
  setInterval(() => {
    const now = performance.now();
    const gap = now - lastBeat;
    lastBeat = now;
    if (warming()) return;
    state.beats++;
    if (gap > state.maxBeatMs) state.maxBeatMs = gap;
    if (gap > STALL_MS) state.timerGaps.push({ atMs: Math.round(since()), ms: round(gap) });
  }, BEAT_MS);

  // ── The frame loop ────────────────────────────────────────────────────────
  let lastTs = null;
  let measuredFrom = null;
  function frame(ts) {
    const t0 = performance.now();
    if (warming()) {
      lastTs = ts;
      watchCanvas();
      requestAnimationFrame(frame);
      return;
    }
    if (measuredFrom === null) measuredFrom = performance.now();
    if (!observedCanvas) watchCanvas();
    if (lastTs !== null) {
      const interval = ts - lastTs;
      state.intervals.push(interval);
      if (state.intervals.length > MAX_FRAMES) state.intervals.shift();
      if (interval > STALL_MS) {
        state.stalls.push({
          atMs: Math.round(since()),
          ms: round(interval),
          periods: round(interval / displayPeriod()),
          // What the page believed about itself while it was getting nothing.
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          intersecting,
          documentHidden: document.hidden,
          hasFocus: document.hasFocus(),
          shipitVisible,
        });
      }
    }
    lastTs = ts;
    state.frames++;
    if (document.hidden) state.hiddenEver = true;
    if (performance.memory) state.heapValues.add(performance.memory.usedJSHeapSize);
    const cb = performance.now() - t0;
    if (cb > state.maxCallbackMs) state.maxCallbackMs = cb;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── Reading the numbers ───────────────────────────────────────────────────
  function warming() { return performance.now() - state.startedAt < WARMUP_MS; }
  /** Elapsed time in the MEASURED window, so the percentages are of what we watched. */
  function measuredMs() { return measuredFrom === null ? 0 : performance.now() - measuredFrom; }
  function since() { return performance.now() - state.startedAt; }
  function round(x) { return Math.round(x * 10) / 10; }

  /** Median of the non-stall intervals — the display period this device runs at. */
  function displayPeriod() {
    const normal = state.intervals.filter((i) => i < STALL_MS);
    if (normal.length === 0) return 16.7;
    const sorted = [...normal].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 16.7;
  }

  /**
   * The verdict, straight off the table in the header comment. Deliberately
   * says "not yet" rather than "fine" while nothing has gone wrong — a run that
   * has not caught a stall has not ruled anything out.
   */
  function verdict() {
    if (warming()) {
      return { code: "warming", text: `Warming up — the game's own boot is not measured. ${Math.ceil((WARMUP_MS - since()) / 1000)}s to go.` };
    }
    const s = summary();
    if (s.stalls === 0) return { code: "clean", text: `No stalls in ${s.ranSec}s of measurement — keep it running.` };
    if (s.timerGapsDuringStalls > 0) {
      return {
        code: "thread-blocked",
        text: "Frames AND timers stopped together — something is blocking the shared main thread, not throttling the frame.",
      };
    }
    // Read at the stalls themselves. "Did this ever happen" would be decided by
    // whatever the page looked like during boot, which is not the question.
    const hiddenAtStalls = state.stalls.some((st) =>
      st.intersecting === false || st.viewport.startsWith("0x") || st.viewport.endsWith("x0"));
    if (hiddenAtStalls) {
      return {
        code: "pane-hidden",
        text: "Frames withheld while timers ran, and this page was not laid out at the time — the pane was hidden (display:none), e.g. the Chat tab was in front.",
      };
    }
    return {
      code: "frames-withheld",
      text: "Frames withheld while timers ran normally and this page stayed laid out — the browser throttled this frame's rendering, which it does when the iframe ELEMENT is outside the ShipIt viewport.",
    };
  }

  /**
   * A burst, not a blip: BURST_STALLS stalls inside BURST_WINDOW_MS. One long
   * frame while the phone does something else is not the reported fault; the
   * report describes stalls arriving in groups.
   */
  function burstNow() {
    if (state.stalls.length < BURST_STALLS) return false;
    const recent = state.stalls.slice(-BURST_STALLS);
    return recent[recent.length - 1].atMs - recent[0].atMs <= BURST_WINDOW_MS;
  }

  function summary() {
    const ranMs = Math.max(1, measuredMs());
    const lostMs = state.stalls.reduce((a, s) => a + s.ms, 0);
    // A timer gap inside a stall window is the discriminating measurement.
    const timerGapsDuringStalls = state.stalls.filter((st) =>
      state.timerGaps.some((g) => Math.abs(g.atMs - st.atMs) < st.ms + 250)).length;
    return {
      ranSec: Math.round(ranMs / 1000),
      frames: state.frames,
      fps: round(state.frames / (ranMs / 1000)),
      displayPeriodMs: round(displayPeriod()),
      stalls: state.stalls.length,
      lostMs: Math.round(lostMs),
      lostPct: round((lostMs / ranMs) * 100),
      longestStallMs: state.stalls.reduce((a, s) => Math.max(a, s.ms), 0),
      maxCallbackMs: round(state.maxCallbackMs),
      longtaskEntries: state.longtasks,
      loafEntries: state.loafs,
      maxTimerGapMs: round(state.maxBeatMs),
      timerGapsOver100ms: state.timerGaps.length,
      timerGapsDuringStalls,
      documentHiddenEver: state.hiddenEver,
      touches: state.touches,
      firstTouchAtMs: state.firstTouchAtMs,
      firstFocusAtMs: state.firstFocusAtMs,
      stallsWhileFrameFocused: state.stalls.filter((st) => st.hasFocus).length,
      stallsWithPageNotLaidOut: state.stalls.filter((st) =>
        st.intersecting === false || st.viewport.startsWith("0x") || st.viewport.endsWith("x0")).length,
      distinctHeapValues: state.heapValues.size,
      shipitVisibilityAvailable: !!sdk?.visibility,
      shipitVisibilityTransitions: state.visibility.length,
      shipitVisibleNow: shipitVisible,
    };
  }

  /** The whole report, small enough to paste into an issue or a chat message. */
  function report() {
    const s = summary();
    const v = verdict();
    const worst = [...state.stalls].sort((a, b) => b.ms - a.ms).slice(0, 12);
    return [
      "ShipIt #2418 frame profile",
      `verdict: ${v.code} — ${v.text}`,
      "",
      `device:  ${window.innerWidth}x${window.innerHeight} @ dpr ${window.devicePixelRatio}, ${navigator.hardwareConcurrency} cores`,
      `ua:      ${navigator.userAgent}`,
      `origin:  ${location.origin}`,
      `started: ${state.startedAtWall}  (sent ${new Date().toISOString()})`,
      `watched: ${observedLabel ?? "no canvas found"}`,
      "",
      JSON.stringify(s, null, 2),
      "",
      "worst stalls (ms, display periods, what the page believed at the time):",
      ...worst.map((st) => `  t+${(st.atMs / 1000).toFixed(1)}s  ${st.ms}ms = ${st.periods} periods  ` +
        `viewport=${st.viewport} intersecting=${st.intersecting} hidden=${st.documentHidden} ` +
        `focused=${st.hasFocus} shipitVisible=${st.shipitVisible}`),
      "",
      "timer gaps over 100ms (empty = the event loop never stalled):",
      state.timerGaps.length
        ? state.timerGaps.slice(0, 12).map((g) => `  t+${(g.atMs / 1000).toFixed(1)}s  ${g.ms}ms`).join("\n")
        : "  none",
      "",
      "window.shipit.visibility transitions:",
      state.visibility.length
        ? state.visibility.map((t) => `  t+${(t.atMs / 1000).toFixed(1)}s  visible=${t.visible}`).join("\n")
        : "  none recorded (either the pane never changed, or this build predates PR #2459)",
    ].join("\n");
  }

  // The HUD is DOM, so it waits for one; the counters above have been
  // running since the script was parsed in `<head>`.
  whenDomReady(() => {
    /**
   * Put the report in the chat. Returns `{ ok, message }` — the caller shows the
   * message, and the automatic capture needs to know whether to keep waiting.
   */
  async function send(headline) {
    // Checked rather than assumed: opening this page directly (not in the
    // Preview pane) leaves `window.shipit` undefined, and reaching into it threw
    // "Cannot read properties of undefined" at the person holding the phone.
    if (!window.shipit?.agent?.sendMessage) {
      return { ok: false, message: "Not embedded in ShipIt — open this in the Preview pane, or use Copy." };
    }
    try {
      await window.shipit.ready;
      await window.shipit.agent.sendMessage({
        text: `${headline}, for ShipIt issue #2418.\n\n\`\`\`\n${report()}\n\`\`\``,
      });
      return { ok: true, message: "Sent — it is in the chat." };
    } catch (error) {
      return { ok: false, message: `Send failed: ${error instanceof Error ? error.message : error}. Use Copy.` };
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────────
    const hud = document.createElement("div");
    hud.id = "shipit-frame-profiler";
    hud.innerHTML = `
      <style>
        #shipit-frame-profiler {
          position: fixed; top: 8px; left: 8px; z-index: 2147483647;
          font: 12px/1.45 ui-monospace, Menlo, monospace; color: #e8f2f6;
          background: rgba(8,20,26,.88); border: 1px solid #2b4a58; border-radius: 8px;
          padding: 8px 10px; max-width: min(92vw, 460px);
          -webkit-user-select: none; user-select: none; touch-action: manipulation;
        }
        #shipit-frame-profiler .head { display: flex; gap: 8px; align-items: center; }
        #shipit-frame-profiler .dot { width: 9px; height: 9px; border-radius: 50%; background: #4ade80; flex: 0 0 auto; }
        #shipit-frame-profiler.bad .dot { background: #f87171; }
        #shipit-frame-profiler .num { font-weight: 600; }
        #shipit-frame-profiler .body { margin-top: 6px; }
        #shipit-frame-profiler.collapsed .body { display: none; }
        #shipit-frame-profiler .verdict { margin: 6px 0; color: #ffd7a1; }
        #shipit-frame-profiler .row { white-space: pre; }
        #shipit-frame-profiler .btns { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
        #shipit-frame-profiler button {
          font: inherit; color: #e8f2f6; background: #17323d; border: 1px solid #2b4a58;
          border-radius: 6px; padding: 9px 12px; min-height: 40px; cursor: pointer;
        }
        #shipit-frame-profiler button:active { background: #23495a; }
        #shipit-frame-profiler .said { margin-top: 6px; color: #9fd8a8; }
      </style>
      <div class="head"><span class="dot"></span><span class="live">starting…</span></div>
      <div class="body">
        <div class="verdict"></div>
        <div class="rows"></div>
        <div class="btns">
          <button data-act="send">Send to agent</button>
          <button data-act="copy">Copy</button>
          <button data-act="reset">Reset</button>
        </div>
        <div class="said"></div>
      </div>`;
    document.body.appendChild(hud);

    const el = (sel) => hud.querySelector(sel);
    // Tapping the header folds it away — the game is underneath and the point is
    // to watch the game.
    el(".head").addEventListener("click", () => hud.classList.toggle("collapsed"));
    // The game listens for pointer input on the whole page; the HUD's own taps
    // are not the player's.
    for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "click"]) {
      hud.addEventListener(type, (e) => e.stopPropagation());
    }

    hud.addEventListener("click", async (e) => {
      const act = e.target instanceof HTMLElement ? e.target.dataset.act : null;
      if (!act) return;
      const said = el(".said");
      if (act === "reset") {
        location.reload();
        return;
      }
      const text = report();
      if (act === "copy") {
        try {
          await navigator.clipboard.writeText(text);
          said.textContent = "Copied.";
        } catch {
          said.textContent = "Clipboard refused — use Send to agent.";
        }
        return;
      }
      if (act === "send") {
        said.textContent = "Sending…";
        said.textContent = (await send("Frame profile from the phone")).message;
      }
    });

    // The automatic half. Armed once per page load: one message when the fault
    // finally shows up is the point, a message every burst would be noise.
    let autoState = "armed";
    async function autoCapture() {
      if (autoState !== "armed" || warming() || !burstNow()) return;
      // Moved out of "armed" BEFORE the await, or the 500 ms tick re-enters and
      // sends the same burst several times.
      autoState = "sending";
      el(".said").textContent = "Burst caught — sending…";
      const outcome = await send("Automatic capture: a burst of withheld frames");
      autoState = outcome.ok ? "sent" : "failed";
      el(".said").textContent = outcome.message;
    }

    setInterval(() => {
      void autoCapture();
      const s = summary();
      const v = verdict();
      hud.classList.toggle("bad", s.stalls > 0);
      el(".live").innerHTML = `<span class="num">${s.fps}</span> fps · ` +
        `<span class="num">${s.stalls}</span> stalls · <span class="num">${s.lostPct}%</span> lost · ${s.ranSec}s`;
      el(".verdict").textContent = v.text;
      el(".rows").innerHTML = [
        `longest stall   ${s.longestStallMs} ms`,
        `timer gaps      ${s.timerGapsOver100ms}  (max ${s.maxTimerGapMs} ms)  ← the discriminator`,
        `longtask/LoAF   ${s.longtaskEntries} / ${s.loafEntries}`,
        `frame callback  max ${s.maxCallbackMs} ms`,
        `page viewport   ${window.innerWidth}x${window.innerHeight}  intersecting=${intersecting} (${observedLabel ?? "picking…"})`,
        `document.hidden ${document.hidden}`,
        `shipit.visible  ${s.shipitVisibilityAvailable ? `${s.shipitVisibleNow} (${s.shipitVisibilityTransitions} changes)` : "SDK absent"}`,
        `auto-report     ${autoState === "armed"
          ? (s.shipitVisibilityAvailable ? "armed — leave this open" : "unavailable (not embedded)")
          : autoState === "failed" ? "failed — use Copy" : autoState}`,
      ].map((r) => `<div class="row">${r}</div>`).join("");
    }, 500);
  });

  window.__shipitFrameProfiler = { summary, report, verdict, state };
  // eslint-disable-next-line no-console
  console.log("[#2418] frame profiler running — window.__shipitFrameProfiler.report()");
})();
