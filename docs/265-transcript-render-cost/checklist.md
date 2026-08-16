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

Still open:

- [ ] Re-trace a **streaming turn on a long session** and compare against the table in
      `plan.md`. A post-merge trace was taken (2026-08-16) and is recorded below, but it
      does **not** close reqs 1–4: it is a different session with a 20x smaller
      transcript and no token stream, so it cannot tell the fixed build from the
      unfixed one.
- [ ] Decide from that measurement whether explicit event batching is still needed
      (design 2) — blocked on the item above; deliberately not built on speculation.
- [ ] Hand-check Ctrl+F, select-all, pin-to-bottom, search jump-to-match on a long
      session (reqs 5, 6, 7, 9) — needs a real transcript; the DOM is unchanged by
      construction (every message still mounted), but that is an argument, not a check.
- [ ] `buildVisualElements` still walks the whole transcript per update. Cheap next to
      what it replaced, but unmeasured against req 3's "must not grow".

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

   Two things make an inverted count an **upper bound** rather than an estimate. The intercept is
   for a near-empty page, and a real DOM raises it. And layer count is not the only thing that
   raises per-frame commit cost: 1,500 elements that each force a paint chunk *without* being
   composited (`?chunk=1500&chunkmode=filter`) push it to 0.135 ms while `visibleLayers` stays at
   **3**. For scale, the dogfood UI measures 3 layers.

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

   Two pieces of weak evidence, in opposite directions, recorded so nobody mistakes either for a
   conclusion. **Against (a):** production's `Commit` is 0.1113 against this build's 0.052–0.058
   at 2 layers, so if attribution matched, the tree would already be larger than a handful — though
   not necessarily by much, since 1,500 *uncomposited* paint chunks reach 0.135 ms here with only
   3 layers. **For (a):** nothing tried in this container makes `Layerize` itself expensive — not
   2,000 `content-visibility` rows, not 1,502 composited layers, and not 1,500 paint chunks in any
   of three flavours, all of which leave it at ~0.003 ms. If (b) were right, something ought to
   have moved it.

   **Eliminated, so nobody re-opens them.** Viewport: the real UI at 3840×2160 gives the same 0.03
   `UpdateLayer`/frame and 0.0024 ms `Layerize` as at 1440×900. An embedded app: the trace has a
   single origin and no preview iframe in the renderer. **GPU rasterisation**: `RasterTask` fires
   61 times for 4.6 ms across the whole 21.8 s production trace — essentially nothing is
   rasterised, as expected when the only thing changing is a compositor-only transform. That is
   also the mechanically coherent answer, since `Layerize` is `PaintArtifactCompositor::Update`,
   main-thread layer-*list* construction from paint chunks: its cost tracks how many layers exist,
   not how or by what they are later rasterised.

   **What settles it: a production `visible_layers` reading.** Two notes for whoever takes it.
   First, look on the **renderer's Compositor thread, not `CrRendererMain`** —
   `draw_property_utils::ComputeDrawPropertiesOfVisibleLayers` is emitted there, and a
   main-thread-scoped search finds nothing while the event is present. Second, its category is
   plain **`cc`**, not `disabled-by-default-cc.debug`, so an existing trace that already carries
   `cc` events may not need re-recording at all. The CDP `LayerTree` domain is *not* an
   alternative: `LayerTree.enable` succeeds in headless and then never emits a single
   `layerTreeDidChange`. Once a number exists, read it against the curve above: of order 100 means
   (b), and `Layerize`'s cost is still unexplained; of order 1,000 means (a), and the remaining
   work is finding what promotes them.

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
