# 265 — Transcript render cost: checklist

- [x] Cancel a superseded `/history` load instead of parsing and discarding it (req 8)
- [x] Stable element identity from `buildVisualElements` (design 1a)
- [x] Ref-backed handler context so upstream callbacks stop invalidating rows (design 1b)
- [x] Extract the memoized `TranscriptRow`; move per-row work into it (design 1a, 1c)
- [x] `matchesByMessage` memoized; row does its own lookup (req 7)
- [x] Guard test: appending a message, and growing the streaming one, must not
      re-render the rows above (`transcript-row-memo.test.tsx`)
- [x] ETag + `304` on `GET /history`; bounded per-session client cache (reqs 10, 11)
- [x] Drop `fileTree` from `/history`; ETag on `/files`; tree fetched under the same
      supersede guard as the transcript (req 12)

From independent review (all fixed, each with a regression test):

- [x] `useSearch` returned a fresh `[]` on every message change, so the no-search case
      rebuilt `matchesByMessage` and re-rendered every row — the fix was defeated in
      production while the guard test passed (reqs 1–4)
- [x] A fire-and-forget `/files` fetch had no session scope, so the outgoing session's
      tree could overwrite the incoming one's
- [x] Row callbacks were dereferenced during render, so a memoized row that never
      re-rendered held a stale closure
- [x] The history cache was FIFO despite the LRU intent — a 304 did not count as a use,
      so the most-revisited session was the one that aged out

- [x] Cache syntax highlighting outside React render state, so a remount stops re-paying 274 ms
      for unchanged text (design 2b), with an end-to-end guard through the real row → markdown →
      `CodeBlock` chain (`transcript-highlight-cost.test.tsx`) — `transcript-row-memo.test.tsx`
      mocks the row and is blind to everything below it

From independent review of that change (all fixed, each with a regression test):

- [x] The write-up attributed the 35 calls to abandoned concurrent renders under
      `useDeferredValue`, on the strength of the trace's 2,515 scroll events. Refuted: the
      transcript's scroll handler only mutates refs, so scrolling schedules no React update, and
      yielding to input can pause work without discarding it. The claim is now the narrow one
      (a mount always runs the factory; an update compares against the last *commit*), and the
      trigger is recorded as unidentified rather than explained.
- [x] The cache was not actually LRU: replacing an entry (same code, different language)
      overwrote the `Map` value without moving its insertion position, so a just-recomputed
      block stayed the oldest and was the next evicted
- [x] 64 entries bounds cardinality, not memory — nothing caps how long a code block may be. A
      character budget is enforced alongside the entry cap, with the most recent entry always kept
- [x] The transcript guards were masked by the cache they validate: counting `hljs` calls, a broken
      memo chain would have shown up as *zero* extra highlights. The probe moved to the memo
      boundary (`highlightCached`), so they measure the chain independently of the cache, plus a
      guard at more distinct blocks than the cache can hold

Still open:

- [x] Commit the real-browser probe rather than describing its results
      (`scripts/fixtures/transcript-highlight-probe.*`), so the eliminations below are reproducible
      and the next investigator does not rebuild it

- [x] Give the probe a listener counter that models DOM deduplication and `once: true`
      auto-removal, so it counts registrations rather than `addEventListener` calls — the naive
      version reported a 160-per-keystroke and 159-per-modal-cycle "leak" that the browser was not
      holding
- [x] Attribute the (bounded, self-clearing) keydown listener cost to the rewind handles with a
      control condition (`?rewind=0`), rather than by inspection

- [x] Establish that the trace's listener rise is **registration churn, not a leak** — the trace has
      163 minor (scavenger) GCs and zero major/mark-compact ones, and only a major GC releases
      detached nodes and their listeners, so "never fell across GCs" was never a retention finding.
      A subtree mounting and unmounting each iteration produces exactly the measured curve.
- [x] Reconcile the trace's +73/+108/+113/+116 outliers with the rewind handles: at two listeners
      per handle they imply 37–58 handles, plausible at the traced session's 14,524 DOM nodes

- [ ] **What subtree registers ~620 listeners on mount is unidentified.** The figure itself survived
      falsification (2,131 counter samples; growth tracks calls not clock; a 2.7 s window with 819
      samples and no heavy call grew by 0), so it is a real per-iteration cost. Nothing reachable in
      the transcript, the diff modal, or a keystroke *retains* listeners — which is the expected
      result for churn, not a missing explanation. Finding the subtree with that mount cost would
      very likely name the loop's engine too.

- [x] Establish the traced surface. **No modal was open during the recording** (user who took the
      trace, 2026-08-30), which excludes `ReadResult` (`ToolCallModal`-only) and `WriteContent`
      (`DiffModal`-only) and leaves `CodeBlock` as the only call site — so the block is a whole-file
      fenced block in the transcript with no usable language on the fence, and since `CodeBlock`
      cannot re-highlight while mounted, the loop **remounts transcript rows**

- [x] Row-key churn **does not** remount, and is eliminated. Inserting and removing a leading
      message shifts every bubble's `m-${el.index}`, but React reconciles keyed children across the
      whole list, so the key *set* is unchanged except at its ends: each fiber is reused and
      re-rendered with the next row's props. Six flips produced **0** `CodeBlock` mounts.
- [x] Point the probe at `highlight.js/lib/core`, the instance `syntax-highlight.ts` actually calls.
      Patching the full `highlight.js` build intercepts nothing, so `__probe.auto` read 0 forever and
      every elimination became a false negative — the **third** instrument in this investigation that
      was blind by construction. Each run now checks for a non-zero baseline at mount before any zero
      elsewhere is believed.
- [x] Give the probe a mount counter that does not go through `highlight.js`. Counting
      `highlightAuto` can no longer detect a remount at all, because `highlightCached` makes one a
      map lookup — the fix blinds the obvious probe, which is the same masking review caught in
      `transcript-highlight-cost.test.tsx`. The probe now counts `code.hljs` nodes entering and
      leaving the DOM.

- [x] Eliminate the ~1.8 s cadence hypotheses. A periodic **re-render** cannot be the engine at any
      cadence — 8 forced re-renders at the real timers' 1 s produce 0 block mounts and 0 highlights,
      and only a remount can re-highlight. `@formkit/auto-animate` (the closest cadence in the repo,
      2 s) is sidebar-only and not an ancestor of `MessageList`; the only keyed elements in
      `App.tsx`/`AppLayout.tsx` are a banner and a dialog; `useNarrowContainer` is Issues-panel only.
- [x] Give the mount counter a positive control (`window.__swapWrapper`, the `AppLayout`
      Fragment/div shape), so a "0 mounts" result is falsifiable rather than free. Four flips: 3
      mounts, and 3 highlight runs with the cache neutered against 0 with it live.
- [x] Establish the loop is **self-scheduled, not timer-driven**: correlation between a call's
      duration and the following idle gap is r = +0.22 (n = 27), where a fixed-period timer would
      give roughly −1. Period = duration + ~10 ms, so a cheaper iteration is a *faster* loop.
- [x] Eliminate click and focus as the trigger, and retract the earlier "focusin immediately before
      the burst" reading — it came from a windowing bug in the analysis script. Direct enumeration:
      `focus`/`focusin`/`DOMFocusIn` each fire exactly once at 7,172.2 ms, 546 ms *after* the burst
      began, and the trace holds exactly one click. Both sit inside an already-running loop.
- [x] Eliminate the `AppLayout` `isMobile` swap for this trace on the **viewport measurement**: the
      full-page `Paint` clip is 2742 × 1906 at `hostDPR: 2`, i.e. 1371 × 953 CSS px, against a
      `(max-width: 767px)` query — stably false by a factor of 1.8, with nothing resizing.
- [x] State the instrument rule once, generally, rather than as four separate incidents
      (`plan.md` → "The rule this investigation kept relearning").

- [ ] **Fix the `AppLayout` Fragment-vs-div remount** (`AppLayout.tsx`, the `isMobile ? <>…</> :
      <div>…</div>` branch). Not this trace's engine — the viewport rules that out — but a real
      latent defect on its own: every crossing of the 768 px breakpoint discards every fiber in the
      transcript and re-highlights every code block. Give both branches the same element type; the
      mobile branch's relative wrapper is load-bearing for the sessions-drawer overlay and has to
      survive. Needs a test asserting a child below the branch keeps identity across an
      `isMobile` flip.

- [ ] **The loop's engine is still unidentified.** The 35 calls are one loop — 29 consecutive calls,
      2.8–6.1 ms apart, 8.2 s long, period = one highlight — that starts 1.8 s *after* scrolling
      begins and outlives the last scroll event by 4.8 s, scheduling each iteration through a
      microtask after the previous commit. Two failures must hold at once: something re-renders
      continuously, and every one of those renders re-highlights. The probe eliminated
      `MessageList`, the memoized rows, `SubagentReport`'s ResizeObserver, the `content-visibility`
      pairing, and both lazy-body fetches. **The surface question is settled** — no modal was open,
      so the payload (16,979 bytes, a whole file) is a whole-file fence rendered by `CodeBlock`, and
      since `CodeBlock` cannot re-highlight while mounted, the loop remounts transcript rows.
      **Every named engine is now eliminated too**: periodic re-render (any cadence, by
      construction), `@formkit/auto-animate`, keyed ancestors, `useNarrowContainer`, history
      rehydration, SSE, click/focus, and — on the viewport measurement — the `AppLayout`
      `isMobile` swap. **The Docs-tab trigger did not close it either, and this is the trap to
      avoid repeating.** A second trace (2026-08-30 12:00, 17.3 s) has an 8,264 ms synchronous
      call that the user reproduced as Docs-tab-conditional, which looked like the handle this
      item needs. It is not: the leaf is `highlight.js` (twenty sampled functions align at a
      constant −1/−2 column offset with the first trace's module, and the 8,264 ms reproduces
      as 8,747 ms on 20.8 KB of prose), while the genuinely tab-conditional bug found in that
      trace — `DocsViewer`'s O(u²·n) grouping — accounts for **≤90 ms** there and is a
      *different* cost. The user then confirmed the freeze also occurs on a repo with few
      markdown files, where the grouping bug cannot bite. So a tab-conditional trigger for a
      transcript highlight is real and still unexplained. What would close it: a trace whose
      component name (record with "Highlight updates when components render" on, or use the React
      Profiler). Whoever picks this up starts from an empty candidate list, not from these.
- [x] **The Docs tab's own freeze is identified and fixed** — a *different* cost from the loop above,
      and the one that matches the user's reproducible trigger ("opening the docs tab freezes the UI;
      with any other tab open it does not"). `DocsViewer` grouped its list with predicates that each
      re-scanned the whole doc list, `hasTrackedSibling` once per candidate sibling — O(u²·n) over n
      docs of which u are untracked — in its render body, and it re-renders with `App`, so every
      update to the transcript paid it again. Measured in Chrome on this repo's real list
      (n = 866, u = 96): **342–486 ms per render**; indexed, **3.6 ms**, with byte-identical
      grouping. Only the Docs branch renders the component, which is exactly why no other tab pays
      it. Guards, each shown able to fail first: a cost guard in `doc-paths.test.ts` (12,894 ms
      pre-fix against a 500 ms budget); a derivation guard in `DocsViewer.test.tsx` watching both the
      index build and the per-doc regrouping (21 `isTrackedIn` calls across 6 renders with the group
      memos removed, against 6); and a duplicate-path guard, since the index counts each tracked
      *path* once where the scan it replaces excluded every entry matching the query.

      **What this does not settle.** It is not established that this is the 8,264 ms leaf in the
      2026-08-30 12:00 trace — that trace was read by another session and attributed to
      `hljs.highlightAuto`, and it was not available here. The precise claim is that the *grouping
      subtree* does not call `highlightAuto`, so an `_highlight` leaf would be a separate cost; it is
      NOT that `highlightAuto` is unreachable while the Docs tab is open, since the transcript stays
      mounted and opening a doc renders its markdown through the same `CodeBlock`. Both costs present
      as one multi-second synchronous `FunctionCall` inside a component render, so the leaf name is
      what distinguishes them, not the shape.

- [ ] The two modal-only `highlightAuto` sites (`ReadResult`, `WriteContent`) still re-highlight on
      every modal open. Deliberately not wired here — a concurrent session is changing language
      selection in exactly those files — so this is a one-line follow-up for whoever lands that.

- [ ] Re-trace a **streaming turn on a long session** and compare against the table in
      `plan.md`. Two post-merge traces exist (2026-08-16, 2026-08-30) and are recorded
      below. **Neither closes reqs 1–4**, and for the same reason both times: no token
      stream. The 2026-08-30 one carried 12 WebSocket frames in 15 s. Until a trace is
      taken *while an agent is writing a reply*, this stays open — a trace of an idle or
      scrolling session cannot tell the fixed build from the unfixed one.
- [ ] Decide from that measurement whether explicit event batching is still needed
      (design 2) — blocked on the item above; deliberately not built on speculation.
- [ ] Hand-check Ctrl+F, select-all, pin-to-bottom, search jump-to-match on a long
      session (reqs 5, 6, 7, 9) — needs a real transcript; the DOM is unchanged by
      construction (every message still mounted), but that is an argument, not a check.
- [ ] `buildVisualElements` still walks the whole transcript per update. Cheap next to
      what it replaced, but unmeasured against req 3's "must not grow".
- [ ] Record one production trace **with the `cc` category enabled**, during a streaming turn on a
      large session. It serves two open questions at once: the reqs 1–4 measurement above, and the
      `visible_layers` reading that decides between the two readings in *Separate finding*
      correction 2 below. Attempted again 2026-08-30 and **missed again** — that trace has 0
      events whose category is exactly `cc`, and no draw-property event on any thread. Whoever
      records the next one must enable `cc` explicitly in the Performance panel; it is off by
      default, and the naive check for "cc" in a category string will wrongly say it is on.

## Post-merge trace, 2026-08-16

Recorded after the fix shipped. Measured with `/persist/trace-report.py`, which reproduces
the baseline trace exactly, so both columns are produced the same way.

| | baseline (2026-08-15) | now (2026-08-16) |
|---|---|---|
| trace length | 17.7 s | 21.8 s |
| main thread blocked | 5.28 s (30%) | 3.81 s (18%) |
| render slices >20 ms | 46, mean 94.6 ms | **0** |
| longest task | **2,745.7 ms** | **164.5 ms** |
| longest slice chain in one task | 29 | 0 |
| heap peak | 461 MB | 109 MB |
| live listeners peak | 206,457 | 2,993 |
| `/history` requests | 2 x 2,604 KB | **1** x 124 KB |
| `/files` | (inside `/history`) | 335 KB, separate |

**Directly confirmed live:** the duplicate history fetch is gone (req 8), and the file tree
is served separately (req 12).

**NOT established — reqs 1–4 stay open.** This is a different session: 124 KB of transcript
against the baseline's 2,604 KB, and 3,986 DOM nodes against 53,628. There was no token
stream either — 18 WebSocket frames in 21.8 s, and SSE traffic only in the first 2 s; the
visible `tool-spinner` says a turn was *waiting on a tool*, not writing. Scaling the
baseline's 92 ms render by transcript size puts an **unfixed** build at roughly 4–5 ms here,
below the 20 ms threshold — so "0 slices" is what both builds would produce. The trace is
consistent with the fix and evidence of nothing.

What would close reqs 1–4: a trace of an agent **streaming a reply** into a session with a
transcript comparable to the baseline's.

## Second post-merge trace, 2026-08-30

A 14.9 s production trace of `nikz.win`. Recorded while the user scrolled the transcript and
typed; **not** a streaming turn (12 WebSocket frames in 15 s), and a mid-size session.

| | baseline (2026-08-15) | 2026-08-16 | 2026-08-30 |
|---|---|---|---|
| trace length | 17.7 s | 21.8 s | 14.9 s |
| main thread blocked | 5.28 s (30%) | 3.81 s (18%) | **10.39 s (70%)** |
| DOM nodes | 53,628 | 3,986 | 14,532 |
| heap peak | 461 MB | 109 MB | 164 MB |
| live listeners peak | 206,457 | 2,993 | 41,274 |

**Does not close reqs 1–4.** Same defect as 2026-08-16 — no token stream — so it still cannot
distinguish the fixed build from the unfixed one. It is recorded because it establishes
something else.

### The dominant cost is now syntax highlighting, not row rendering

`hljs.highlightAuto()` is **52% of the trace**: 7,786 ms of self time in the `_highlight`
leaf, 8,847 ms across the whole highlight.js module, out of 14,897 ms. 35 calls, all
synchronous inside a React render. Reconstructed stack, leaf first: `_highlight` ← the
`.map()` arrow inside `highlightAuto` ← a `useMemo` callback ← a function component ←
`renderWithHooks` ← `beginWork` ← `renderRootSync`.

`highlightAuto` is not told the language, so it highlights the text once per registered
language — all 192 — and compares relevance. Measured in a browser on 12 KB (11,975 chars):

| call | cost |
|---|---|
| `highlightAuto(code)` — all 192 languages | 248.9 ms |
| `highlightAuto(code, subset)` — 13 languages | 19.6 ms |
| `highlight(code, {language})` | 4.1 ms |

248.9 ms reproduces the 274 ms in the trace. Two of the three call sites can know the language
and do not: `ToolResult.tsx:190` (its `extractFilePathFromReadContent` helper is dead code —
every path returns `null`, and line 185 discards the result) and `DiffBlock.tsx:259` (the
parent's `filePath` is not passed to `WriteContent`). Tracked separately.

**One payload, ~35 times — mechanism NOT established.** Cost per call is near-constant
(p50 274 ms, p90 276 ms, max 277 ms) while `highlightAuto` cost scales with input size
(13 ms at 1 line, 172 ms at 200, 396 ms at 600). So the same content is highlighted over and
over. `useMemo` compares strings by value and cannot retrigger on an unchanged one, which
points at a remount rather than a re-render — supported by listeners more than doubling
(19,521 → 41,274) while DOM nodes stayed flat (14,524 → 14,532) and never falling across
several GCs. Whether the row memo of this design is implicated is **not** established.

### Idle compositing persists, and `cc` was missed again

`Layerize` 0.5590 ms/call and `Commit` 0.1211 ms/call over 638 frames, against the
*Separate finding* section's 0.6500 and 0.1113 — the phenomenon reproduces on a second
production recording, so correction 2's open question is not an artifact of one trace.
42.8 main-thread frames/s with nothing streaming.

The `visible_layers` reading is still missing: 0 events with category exactly `cc`, and the
renderer's Compositor thread carries the same 21 PipelineReporter-family event names as
before, with no draw-property event under any name. **This trace cannot decide between
readings (a) and (b) either.**

## Separate finding — continuous idle compositing

Not the reported freeze, not a regression, and not caused by this work — but it is now the
largest steady cost, and the freeze was previously masking it.

Between 2 s and 20 s the trace has no user input and almost no network, yet the page produces
**~118 frames per second** and spends **~150 ms per second** on the main thread, with `Commit`,
`UpdateLayoutTree`, `PrePaint` and `IntersectionObserver` work each running ~1,800 times in 15 s.
Over the whole 21.8 s trace the main thread is busy 3,813 ms (17.5%), of which **`Layerize` is
1,669.8 ms — 44%**, at a mean of 0.65 ms across 2,569 events.

**These are two separate problems sharing one trace.** The frames are caused by the interaction
below, and fixing it removes them. What makes each frame cost 0.65 ms is a separate problem, still
open: correction 2 has the calibration curve for it and states plainly what it cannot yet decide.

The first reading blamed the infinite CSS animation that runs while a tool does —
`.tool-spinner { animation: spin-slow 1s linear infinite }` (`src/client/index.css:387`), used
by `StreamingIndicator.tsx:28` and `TodoPanel.tsx:53`. That attribution was inferred from one
trace. It has since been measured, and it is **half right**: the spinner is what makes frames
happen, and it is not what makes them cost anything.

### Measured attribution

Reproduce with `node scripts/trace-idle-frames.mjs <url>` against
`scripts/fixtures/idle-frame-cost.html`, which toggles one ingredient per query param. The
number that matters is `beginMainThreadFramesPerSecond` — a composited animation drives the
compositor at display rate while leaving the main thread asleep.

Two runs per condition, 8 s windows (the display ran at ~50 Hz here):

| fixture | compositor frames/s | **main-thread frames/s** | main-thread busy |
|---|---|---|---|
| spinner alone | 51.3 / 49.2 | **0 / 0** | 1.6 / 1.6 ms/s |
| spinner + one live `IntersectionObserver` | 50.3 / 38.1 | **50.4 / 38.2** | 21.0 / 18.2 ms/s |
| spinner + 300 `content-visibility:auto` rows | 49.2 / 49.2 | **49.2 / 49.2** | 43.6 / 43.8 ms/s |
| 300 `content-visibility:auto` rows, no spinner | 0 / 0 | **0 / 0** | 3.8 / 0.2 ms/s |

So neither ingredient costs anything on its own, and the rule is:

> **A live `IntersectionObserver` makes every scheduled frame need main-thread work.** An
> always-on animation makes the browser schedule a frame every vsync. Either alone is free;
> together they run style recalc, pre-paint, the intersection pass and commit at display rate.

Two precisions on that wording, both measured rather than assumed. **Layout and paint do not
run** — no `Layout` or `Paint` events appear in these traces at all, because nothing changes size
or pixels on the main thread; the animation's transform is the compositor's business. And the
trigger is the *scheduled* frame, not the drawn one: an animating element scrolled out of view
still drives ~48 main-thread frames/s while the compositor draws **zero**. That is worth knowing
because it is also a trap for whoever measures this next — an accidentally-offscreen probe looks
idle by draw rate while costing full price.

Chrome creates those observers internally for **every `content-visibility: auto` element**, which
is why the transcript is implicated at all — `MessageList.tsx:360` puts it on every row. Sweeping
the row count (`?spin=1&cv=1&n=…`, same protocol) gives main-thread busy of 1.6 ms/s at 0 rows,
then 24.1 / 32.1 / 44.7 / 76.3 / 171.8 ms/s at 50 / 150 / 300 / 800 / 2,000.

Two things in that shape matter more than the slope. The **step** is at the *first* row: 0 rows
means no main-thread frames at all, and one row means all of them — after which the points fit
`≈20 + 0.076·rows` ms/s to within about 6%. And the slope means the cost **grows with the
conversation**, so the long sessions reqs 1–4 are about are also the ones paying most here.

### Both sources have to go, or neither is worth touching

ShipIt has a **second** source of live observers: `@formkit/auto-animate`, used once at
`SessionSidebar/SessionGroup.tsx:380`. Three of its observers were live when this session was
sampled. That count is a *measurement, not a property of the library* — 0.9.0 creates one per
offscreen element and disconnects it once the element scrolls in, so the number tracks how much
of the sidebar is out of view. (It also holds a document `ResizeObserver`, a per-parent
`MutationObserver`, a scroll listener and a 2 s per-element interval; only the intersection
observers matter here.)

On the real UI — dogfood session, 21 `content-visibility` rows, 60 Hz, 10 s windows, two runs
each. Reproduce with `scripts/fixtures/inject-probe-animation.js` as `--eval` (`#no-cv` and
`#no-anim` in the URL fragment select conditions) and
`scripts/fixtures/neuter-intersection-observer.js` as `--init`:

| condition | main-thread frames/s | main-thread busy |
|---|---|---|
| nothing animating | 4.4 / 4.9 | 4.6 / 4.6 ms/s |
| **today** — animation + both observer sources | 59.9 / 60.0 | 35.7 / 37.8 ms/s |
| animation, `IntersectionObserver` neutered from boot | 59.9 / 60.0 | 34.5 / 36.4 ms/s |
| animation, `content-visibility` disabled | 60.0 / 59.9 | 37.6 / 40.8 ms/s |
| animation, **both** removed | 8.6 / 8.5 | 9.2 / 9.0 ms/s |

The frame rate is the deterministic part: it stays pinned at display rate whenever *either* source
survives, and collapses only when both go. Busy-time differences between the three top rows are
within the run-to-run spread and n=2 cannot resolve them — the honest statement is **no material
change**, not zero. What two runs can exclude is anything close to the both-removed effect: that
is a ~75% saving, roughly twenty times larger than any single-source difference here, and it
reproduces across every run.

So the practical warning stands: whoever drops `content-visibility: auto` on its own will measure
no change and conclude the finding was wrong. It is the pairing that has to break.

One caveat on the `content-visibility disabled` row: forcing `content-visibility: visible` removes
Chrome's internal observers *and* makes off-screen rows render for real, so that row is not a clean
isolation of the observers alone. It slightly exceeding the `today` row is consistent with that.

### Three corrections to the section above

1. **The spinner already composites.** `transform: rotate()` on it runs entirely on the
   compositor — the fixture's first row is that measurement. "Make the spinner composited" is
   not an available fix, because there is nothing to fix.
2. **The 0.65 ms per frame is real, and it is a second problem — not part of this one.** It
   survived re-derivation against the original trace and is not a measurement error. What it is
   *caused by* is still open. Composited layer count is the one thing that reproducibly moves
   per-frame cost here, but nothing tried in this container makes the slice named `Layerize`
   expensive: 2,000 `content-visibility` rows, 1,502 promoted layers and the real UI at three
   viewport sizes all keep it at **0.002–0.004 ms/call**.

   That gap was checked against the original trace rather than assumed away, and it survives:
   `RunTask` on `CrRendererMain` is 100% depth-0 there, so nothing is double-counted (union-merging
   the intervals and naively summing both give 3,813 ms, identical to the millisecond); all 2,569
   `Layerize` events are on one thread, totalling 1,669.8 ms for a straight mean of 0.65 ms. It is
   **44% of main-thread busy time over the 21.8 s trace** — the earlier "1,170 ms of 2,287 ms in
   the 5–20 s window, over half" came from a scratch script with faulty stack logic and should not
   be quoted.

   **DOM size is eliminated as the axis**: the 2,000-row sweep is several times production's 3,986
   nodes and still far cheaper, so node count is the wrong thing to compare on. The leading
   candidate is the composited layer tree — production runs **28.9 `UpdateLayer` per frame**
   (74,135 over 2,569 frames) against ~0.03 here — but `UpdateLayer` only correlates with tree
   size, and the count itself is still unmeasured in production. That is the gap below.

   **Layer count moves per-frame cost, and here is the calibration curve.** `?promote=N` puts
   `will-change: transform` on N small on-screen boxes, so each is a real composited layer:

   | visible layers | 2 | 52 | 202 | 602 | 1,502 |
   |---|---|---|---|---|---|
   | per-frame commit cost | 0.052–0.058 | 0.066 | 0.107 | 0.224 | 0.635–0.891 ms |
   | `Layerize` | 0.0023 | 0.0022 | 0.0025 | 0.0021 | 0.0022–0.0030 ms |

   Linear in the layer count, at **roughly 0.4–0.55 µs per layer per frame over a ~0.055 ms
   intercept**. It is a range and not a constant: the 1,502-layer point moved ±20% across five
   runs with container load, so quote it to one significant figure. Invert it to read a layer
   count off a per-frame time, or apply it forwards to a measured count:

       layers ≈ (per-frame ms − 0.055) / 0.0004   … to   / 0.00055

   Two things make an inverted count an **upper bound** rather than an estimate: the intercept is
   for a near-empty page and a real DOM raises it, and layer count is not the only thing that
   raises per-frame commit cost (see the constraint below). For scale, the dogfood UI measures
   **3** visible layers.

   **What is NOT established: which production slice to feed into that curve.** Production's
   whole-trace per-call means on `CrRendererMain` (n = 2,569 frames) are `Layerize` 0.6500,
   `Commit` 0.1113, `UpdateLayoutTree` 0.0950, `PrePaint` 0.0701. Two of those invert to answers
   an order of magnitude apart:

   | read production's… | implied layer tree (upper bound) |
   |---|---|
   | `Commit` (0.1113) | **~100–140 layers** |
   | `Layerize` (0.6500) | **~1,100–1,500 layers** |

   So either **(a)** the builds attribute this work to different slice names — production's
   `Layerize` is this build's `Commit` — and ShipIt carries of order a thousand layers; or **(b)**
   attribution matches, ShipIt carries ~100, and production's 0.65 ms `Layerize` has a different
   cause altogether. **One trace cannot separate them, and neither reading should be quoted as
   settled.** An earlier draft of this section leaned on the 1,502-layer point landing within
   0.001 ms of production's 0.650; the run-to-run spread above is 20× that difference, so the
   match was precision that was never there.

   **A per-frame cost cannot be inverted into a layer count. This is a constraint on the method,
   not a caveat on one number.** `?chunk=1500&chunkmode=filter` gives 1,500 elements that each
   force their own paint chunk *without* being composited. Per-frame commit cost then runs
   0.073–0.135 ms across runs while `visibleLayers` stays at **3** — against a 0.052–0.058 baseline
   at 2 layers, and bracketing production's 0.1113, from essentially no layers at all. So both
   readings above are upper bounds, and **no arithmetic on a per-frame time will decide between
   them.** The layer count has to be measured directly.

   Two pieces of weak evidence, in opposite directions, recorded so nobody mistakes either for a
   conclusion. **Against (a):** production's `Commit` is 0.1113 against this build's 0.052–0.058 at
   2 layers, so if attribution matched, the tree would already be larger than a handful — though
   the constraint above means not necessarily by much. **For (a):** nothing tried in this container
   makes `Layerize` itself expensive — not 2,000 `content-visibility` rows, not 1,502 composited
   layers, and not 1,500 paint chunks in any of three flavours, all of which leave it at
   ~0.003 ms. If (b) were right, something ought to have moved it.

   **Eliminated, so nobody re-opens them.** Viewport: the real UI at 3840×2160 gives the same 0.03
   `UpdateLayer`/frame and 0.0024 ms `Layerize` as at 1440×900. An embedded app: the trace has a
   single origin and no preview iframe in the renderer. **GPU rasterisation**: `RasterTask` fires
   61 times for 4.6 ms across the whole 21.8 s production trace — essentially nothing is
   rasterised, as expected when the only thing changing is a compositor-only transform. That is
   also the mechanically coherent answer, since `Layerize` is `PaintArtifactCompositor::Update`,
   main-thread layer-*list* construction from paint chunks: its cost tracks how many layers exist,
   not how or by what they are later rasterised.

   **What settles it: a production `visible_layers` reading, which needs a new recording.** The
   existing trace was searched thread-scoped and case-insensitively for every spelling
   (`drawprop`, `draw_prop`, `visible_layer`, `layer_count`, `num_layers`): zero matches on any
   thread. Its single renderer Compositor thread carries 21 distinct event names, all
   PipelineReporter-family plus the frame/commit/activation events — no draw-property event under
   any name.

   Two things to get right when recording it, both of which cost a wasted recording otherwise:

   - **Enable `cc` explicitly.** `draw_property_utils::ComputeDrawPropertiesOfVisibleLayers` has
     category exactly `cc`, and DevTools' Performance-panel defaults do not include it.
   - **Do not infer that `cc` is on from seeing "cc" in an event's category string.** Chrome
     records an event if *any* of its comma-separated categories is enabled, so an event tagged
     `cc,benchmark,disabled-by-default-devtools.timeline.frame` proves only that one of those three
     is on. The sound test is the reverse: if events whose category is *exactly* `cc` are absent,
     `cc` is off. That is how the trace above was diagnosed after the naive reading said otherwise.

   Then read the count on the **renderer's Compositor thread**, not `CrRendererMain`, and put it
   through the curve above: of order 100 means (b), and `Layerize`'s cost is still unexplained; of
   order 1,000 means (a), and the remaining work is finding what promotes those layers. The CDP
   `LayerTree` domain is not an alternative — `LayerTree.enable` succeeds in headless and then
   never emits a single `layerTreeDidChange`.

3. **`content-visibility` causes the frames; something else decides what each one costs.** The
   original section reads as a single phenomenon with the spinner at its root. It is two: the
   observer/animation pairing decides *how many* main-thread frames happen, and whatever drives
   correction 2 decides *what each one costs*. They multiply, which is why the production number is
   so much larger than anything reproduced here, and they are fixable independently — the first is
   understood today, the second is not.

### Decision: no code change, and what would justify one

Not fixed here, deliberately. The cost is real: **~28 ms/s of main thread** on this 21-row
session while any tool runs (36.8 today against 9.1 with both sources removed), and it grows with
the transcript. That is deliberately not compared against the original trace's ~150 ms/s: 44% of
that is layerization this reproduction never saw, so the two numbers count different things.
What transfers is the mechanism and the shape, not the milliseconds.

Removing the pairing is still worth doing on the production trace's own terms, and more so there
than here — it removes ~110 of the ~118 frames per second, and each frame it removes takes its
0.65 ms of `Layerize` with it. That is the reason the two problems are worth separating rather
than merging: fixing the cheap one pays the expensive one back at 118× per second.

Every available fix removes something load-bearing:

- **Dropping `content-visibility: auto`** trades this measured idle cost against an *unmeasured*
  benefit. It is there so a long transcript does not lay out and paint every off-screen row, and
  `useMessageScroll` is written around the placeholder-then-grow behaviour it produces
  (`useMessageScroll.ts:43,137`). Removing it without measuring the load and scroll cost it saves
  would be trading a known quantity for an unknown one.
- **Dropping `@formkit/auto-animate`** costs the sidebar its list animation and, on its own,
  changes nothing material (see the table) — the frame rate stays pinned at display rate.

The honest position is that this is a **real but conditional** cost: it is paid only while
something animates, i.e. while a tool runs, and it grows with transcript length.

**The experiment that would settle it** — and unlike reqs 1–4 it needs no real long session,
because synthetic rows are enough to measure layout and paint work:

1. Fixture: `scripts/fixtures/idle-frame-cost.html` at `n=2000`, `spin=0`, with `cv=1` and `cv=0`
   as the two conditions. Give the rows message-shaped content (headings, prose, a code block)
   rather than the current filler, since paint cost tracks what is actually drawn.
2. Metrics, all main-thread: time to first contentful paint, total `RunTask` from navigation to
   the first idle frame, and `Layout` + `Paint` + `UpdateLayoutTree` totals during a scripted
   scroll from top to bottom. Tracing has to start **before** navigation, which
   `trace-idle-frames.mjs` does not do — it starts after load, by design, so this needs a variant.
3. Decision rule: if `cv=1` saves less than the ~28 ms/s (and rising) that this section measures it
   costing, remove `content-visibility: auto` **and** `@formkit/auto-animate` together — one
   without the other buys nothing — and re-run the table above to confirm the 75%. If it saves
   more, this section is the record of why the cost is accepted.

Caveat on the numbers: they were recorded in a container with no GPU, so rasterisation is
software and absolute milliseconds are not a user's machine. Every comparison above is between
conditions measured the same way, which is the claim being made.
