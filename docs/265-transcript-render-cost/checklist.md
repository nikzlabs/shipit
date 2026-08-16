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
**~118 frames per second** and spends **~150 ms per second** on the main thread. Over half of
that is `Layerize` (1,170 ms of 2,287 ms in the window, ~0.65 ms every frame); the rest is
`Commit`, `UpdateLayoutTree`, `PrePaint` and `IntersectionObserver` work, each running ~1,800
times in 15 s.

The driver is an infinite CSS animation that never stops while a tool runs:
`.tool-spinner { animation: spin-slow 1s linear infinite }` (`src/client/index.css:387`),
used by `StreamingIndicator.tsx:28` and `TodoPanel.tsx:53`. 136 `animationiteration` events
in the idle window imply several instances running at once. Any always-on animation forces a
frame every vsync; what makes it cost this much is that each frame re-layerizes the page.

Worth investigating separately: whether the spinner can be composited (so frames cost the
compositor rather than the main thread), and why `Layerize` is 0.65 ms on a 4,000-node page.
