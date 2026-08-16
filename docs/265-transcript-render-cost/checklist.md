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
(That trace also attributed 1,170 ms of the window to `Layerize`. It has not reproduced — see
*Three corrections* below.)

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

| fixture | compositor frames/s | **main-thread frames/s** | main-thread busy |
|---|---|---|---|
| spinner alone | 49.6 | **0** | 1.5 ms/s |
| spinner + one live `IntersectionObserver` | 49.6 | **49.6** | 18.5 ms/s |
| spinner + 300 `content-visibility:auto` rows | 49.5 | **49.7** | 40.4 ms/s |
| 300 `content-visibility:auto` rows, no spinner | 0 | **0** | 0.3 ms/s |

So neither ingredient costs anything on its own, and the rule is:

> **A live `IntersectionObserver` forces a full main-thread rendering lifecycle on every frame
> the compositor produces.** An always-on animation makes the compositor produce a frame every
> vsync. Either alone is free; together they run style, layout, pre-paint, paint and commit at
> display rate.

Chrome creates those observers internally for **every `content-visibility: auto` element**, which
is why the transcript is implicated at all — `MessageList.tsx:360` puts it on every row. The cost
is linear in the row count, so it grows with the conversation: measured at
`1.6 + ~0.06·rows` ms/s (1.6 at 0 rows, 17.9 at 50, 33.2 at 300, 56.3 at 800, 121.4 at 2,000).

### Both sources have to go, or neither is worth touching

ShipIt has a **second** source of always-live observers: `@formkit/auto-animate`, used once at
`SessionSidebar/SessionGroup.tsx:380`, keeps three of them alive for the life of the page. On the
real UI (dogfood session, 21 `content-visibility` rows, 60 Hz, 10 s windows, two runs each):

| condition | main-thread frames/s | main-thread busy |
|---|---|---|
| nothing animating | 4.5 / 4.9 | 5.4 / 5.7 ms/s |
| **today** — animation + both observer sources | 59.9 / 59.9 | 58.4 / 58.2 ms/s |
| animation, `IntersectionObserver` neutered from boot | 60.0 / 59.9 | 56.7 / 55.5 ms/s |
| animation, `content-visibility` disabled | 59.9 / 59.9 | 58.9 / 57.0 ms/s |
| animation, **both** removed | 9.1 / 9.1 | 14.4 / 15.1 ms/s |

Removing either source alone buys **nothing measurable** — the other keeps the per-frame
lifecycle running. Removing both is worth ~75% of the cost. Anyone who picks this up and drops
`content-visibility: auto` expecting a win will measure no change and conclude the finding was
wrong; it is the pairing that has to break.

### Three corrections to the section above

1. **The spinner already composites.** `transform: rotate()` on it runs entirely on the
   compositor — the fixture's first row is that measurement. "Make the spinner composited" is
   not an available fix, because there is nothing to fix.
2. **`Layerize` did not reproduce.** In every configuration measured — up to 2,000
   `content-visibility` rows, up to 300 `will-change` layers, and the real UI — `Layerize` runs at
   **0.002–0.004 ms/call**, totalling ~1 ms across thousands of frames, and never exceeds ~3% of
   `Commit`. The reported 0.65 ms/call is ~200× that. The per-frame cost is instead dominated by
   `UpdateLayoutTree` (style recalc) and `computeIntersections`. The 1,170 ms figure is unexplained
   and should be treated as an analysis artifact until someone re-derives it; the neighbouring
   `UpdateLayer` count of 20,624 (≈11 per frame, against a handful per *trace* here) suggests the
   script summed something nested or cross-thread.
3. **`content-visibility` is a *cause*, not an aggravator.** The section above reads as though
   layerization were expensive and `content-visibility` merely nearby. It is the other way round.

### Decision: no code change, and what would justify one

Not fixed here, deliberately. The cost is real — ~42 ms/s of main thread while any tool runs,
which on the 118 Hz machine that produced the original trace scales to roughly the 150 ms/s it
reported — but every available fix removes something load-bearing:

- **Dropping `content-visibility: auto`** trades this measured idle cost against an *unmeasured*
  benefit. It is there so a long transcript does not lay out and paint every off-screen row, and
  `useMessageScroll` is written around the placeholder-then-grow behaviour it produces
  (`useMessageScroll.ts:43,137`). Removing it without measuring the load and scroll cost it saves
  would be trading a known quantity for an unknown one.
- **Dropping `@formkit/auto-animate`** costs the sidebar its list animation and, on its own,
  buys nothing (see the table).

The honest position is that this is a **real but conditional** cost: it is paid only while
something animates, i.e. while a tool runs, and it is proportional to transcript length. What
would settle it is one experiment, which needs the long session reqs 1–4 are already waiting on:
**measure what `content-visibility: auto` saves at load and on scroll for a transcript of a few
thousand rows.** If the saving is small, remove it *and* `auto-animate` together and take the 75%.
If it is large, this section is the record of why the cost is accepted.

Caveat on the numbers: they were recorded in a container with no GPU, so rasterisation is
software and absolute milliseconds are not a user's machine. Every comparison above is between
conditions measured the same way, which is the claim being made.
