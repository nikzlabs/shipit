---
issue: planning#375
title: Transcript render cost — design
description: Bail out unchanged transcript rows, and make a session switch revalidate instead of re-download.
---

# 265 — Transcript render cost: design

Implements [`requirements.md`](./requirements.md). Requirements are cited as `(req N)`.

## What the trace established

A 17.6 s DevTools trace of a live session (analysis in `planning#375`):

| Measurement | Value |
|---|---|
| Main thread blocked | 4.35 s of 17.6 s, in bursts of 1.2 s / 0.65 s / **2.75 s** |
| Render slices | **46**, each a uniform **92 ms** (±5 ms) |
| Longest single task | 2.75 s, holding **31** of those renders back-to-back |
| JS heap | 105 MB → 461 MB |
| Live event listeners | 5,960 → 206,457 |
| `/history` | fetched **twice**, 2.67 MB each |

The cost per render is *constant* and the count varies — so the fix is to stop paying
92 ms for an update that changed one message, not to make 92 ms faster.

## Why the render costs 92 ms

`MessageList` maps `visualElements` to inline JSX (`MessageList.tsx:333`). Nothing between
the transcript and the DOM is memoized per row, so every element re-renders on every
update. Three things then run once per message per update:

- React's `beginWork` over the whole fiber tree — the bulk of the 92 ms;
- `parseMessageSegments(msg.text)` (`MessageList.tsx:392`), called unconditionally;
- `renderMessageCard(msg, …)` and the `matchesByMessage` rebuild (`MessageList.tsx:230`),
  neither memoized.

`useDeferredValue` (`MessageList.tsx:151`) already coalesces the *rate*. It cannot help with
the *cost*: a deferred render that keeps being restarted by the next token eventually
expires, and React then finishes it synchronously — which is what the profile shows
(`renderRootSync`, no yielding inside a 92 ms slice).

## Design

### 1. Bail out unchanged rows (reqs 1–4, 9)

Every message stays mounted — the user chose that, so Ctrl+F and select-all keep covering
the whole conversation (req 9). What changes is that React skips the subtree of a row whose
inputs did not change. During a streaming turn only the last row changes, so the per-update
cost becomes proportional to what changed (req 3) rather than to the conversation.

Three things have to hold for `React.memo` to actually bail out:

**a. Stable element identity.** `buildVisualElements` rebuilds every element object on every
call, so `el` is never referentially equal. It gains a reconcile pass: build as today, then
return the *previous* object for any element that is structurally unchanged. The walk stays
O(n) — a few ms over the whole transcript — but its output is stable, which is what the
memo needs.

**b. No volatile props.** The per-row component takes only values that are stable while the
row is unchanged: its element, its message, and indices. Everything volatile — the callback
props `MessageList` receives (re-created by its parent every render), `messages`,
`findPlanContent` — moves behind a **ref-backed context** whose identity never changes.

Each callback is exposed as a **permanent wrapper that forwards to the latest one**, not as
an inline read of `ref.current`. That distinction is load-bearing and was caught in review: a
row hands these callbacks to its children (`onAnswerQuestion` to a `ToolUseItem`, `onRewind`
to a `RewindPoint`) and may then never render again, so dereferencing during render would
leave it holding a dead closure — stable identity bought with a correctness bug. Optionality
survives the indirection via a getter, because several cards gate a control on whether its
handler *exists*, and a wrapper where the parent passed nothing would draw a button that does
nothing.

**The prop-stability contract reaches outside this component, which is its real hazard.**
`useSearch` memoized on `messages` and returned a fresh `[]` when there was no query — so the
no-search case, i.e. almost always, produced a new array per token, rebuilt
`matchesByMessage`, and re-rendered the whole transcript anyway. The fix is a shared empty
array at the source plus a shared empty `Map` in `MessageList`; the guard test now passes
`searchMatches` explicitly, because a memo defeated from two components away fails silently.

**c. Per-row work moves into the row.** `parseMessageSegments` and `renderMessageCard` run
inside the memoized row, so an unchanged row does not run them at all.

`matchesByMessage` becomes a `useMemo` over `searchMatches`, passed whole; the row does its
own lookup, so a row with no matches is unaffected by a search elsewhere (req 7).

Not changed: `useMessageScroll` and its ResizeObserver (req 5), the `content-visibility`
utilities, and `ChatQuoteReply` (req 6) — all of which depend on the full transcript being in
the DOM, which it still is.

### 2. Coalescing the burst — sequenced, not assumed (req 4)

The 31-renders-in-one-task chain is a *consequence* of each render costing 92 ms: React
starves, expires the deferred render, and finishes it synchronously. With rows bailing out,
the chain should not form. So this is sequenced **after** step 1 and gated on re-measuring:
if a burst still appears in a fresh trace, add explicit batching at the event-drain
(`hooks/message-handlers/`); if it does not, adding a second coalescing layer on top of
`useDeferredValue` is mechanism nobody needs.

### 2b. Syntax highlighting is cached outside React (reqs 1–4)

A later production trace (2026-08-30, 14.9 s) found `hljs.highlightAuto` called **35 times for
9.5 s** of a 10.4 s busy main thread, with near-constant durations (p50 274 ms, p90 276, max 277)
— i.e. the *same* payload, over and over. Every call site already wraps it in a `useMemo` keyed
on the block's text, which is why that reads as impossible.

**Two independent changes came out of that trace, and they compose.** `syntax-highlight.ts` bounds
highlight.js to a registered subset, which makes each auto-detect cheaper (roughly 20 ms for this
block rather than 274) and is the single place language policy lives. This section makes the answer
survive a fiber that does not, so a *repeat* costs nothing. `highlightCached` therefore delegates to
`highlightCode` and decides nothing itself — adding a language still reaches every call site with no
edit in the cache. The absolute milliseconds below are from before the subset landed; the counts,
which is what everything here rests on, are unaffected.

It is not, because **a `useMemo` is not a cache**: React discards a memoized value when the fiber
does not survive. Two cases, and the second is narrower than it is tempting to write:

- A **mounting** component always runs the factory, so every remount pays the full cost again — a
  modal, tooltip or disclosure holding a code block reopening, or anything that remounts
  transcript rows.
- On an **update**, React compares deps against the last *committed* value rather than the last
  attempt (verified in react-dom 19.2.8: `updateWorkInProgressHook` clones the hook from
  `currentlyRenderingFiber.alternate`, and `updateMemo` compares against that clone). So a render
  React abandons and retries recomputes any memo whose deps differ from the commit — but an
  **unchanged** block is *not* recomputed merely because a render was interrupted.

An earlier draft of this section attributed the 35 calls to the second case, on the grounds that
step 1 renders the transcript behind `useDeferredValue` and the trace has 2,515 scroll events.
Independent review refuted it and the refutation holds: the transcript's scroll handler only
mutates refs (`useMessageScroll.ts`), so scrolling schedules no React update at all, and yielding
to browser input can pause work without discarding it. 2,515 scroll events are not 2,515
higher-priority React updates. **The trigger for those 35 calls is therefore still unidentified.**

So the answer moves out of render state into a bounded LRU keyed by the code string
(`utils/highlight-cache.ts`), making the cost a property of the *content* rather than of the
render lifecycle. That is a **mitigation, not an identification**: it removes the cost of a
remount whatever causes one, and it does not prove which surface the trace recorded. Nothing about
which language is chosen changes.

Verified in a real browser (a Vite harness rendering the real `MessageList` over a 120-message
transcript, so `content-visibility`, `ResizeObserver` and `IntersectionObserver` are real rather
than jsdom stubs): scrolling hard, 20 parent re-renders, and replacing every `ChatMessage` object
each produce **zero** extra highlights. So the memo chain from step 1 holds, and the repetition
the trace recorded is not a defeated row memo.

Whole-transcript remount paths that *do* exist, for whoever picks the trigger question up: history
being cleared and rehydrated; the onboarding/home panel replacing the conversation (`App.tsx`); and
crossing the mobile/desktop breakpoint, which swaps two distinct trees in `AppLayout`. Mobile
Chat/Workspace tab switching is **not** one — `MobileContentPanels` keeps both trees mounted on
purpose. None of the three is obviously firing 35 times in 15 s, which is why the question is open
rather than answered.

#### The 35 calls are one loop, not 35 events

Grouping the trace's calls by the idle gap between them gives four bursts, and the last one is the
whole story: **29 consecutive calls with 2.8–6.1 ms of idle between them, running for 8.2 s**, at a
period of ~284 ms — one `highlightAuto` plus the gap. The loop is rate-limited by its own cost.
Three facts constrain it:

- **It outlives the scroll.** Scroll events span 4,825–10,068 ms; the burst starts at 6,626 ms (1.8 s
  *after* scrolling began) and runs to ~14,860 ms (4.8 s after the last scroll event). Scrolling
  neither starts nor sustains it.
- **The typing is a victim, not a cause.** All five keystrokes land inside the burst, which is why
  each cost ~57 ms: they queued behind a 274 ms task.
- **Each iteration schedules the next through a microtask**, after the previous render commits:
  highlight ends → `RunMicrotasks` → a sub-millisecond `FunctionCall` → `RunTask` → the next
  highlight. Some gaps also run real layout (`UpdateLayoutTree`, `Layout`, `PrePaint`,
  `IntersectionObserverController::computeIntersections`, `Layerize`, `Commit`).
- **The loop is self-scheduled, not timer-driven — measured, not inferred from the shape.**
  Correlation between a call's duration and the idle gap that follows it is **r = +0.22** (n = 27).
  A fixed-period timer would give r near **−1**, because the gap would absorb the variation in
  duration. It does not: period = duration + ~10 ms. That distinction is what makes the cost fix and
  the loop fix interact — a cheaper iteration is a *faster* loop, not a shorter one.

That is the signature of an unconditional re-render, so **two failures have to hold at once**:
something re-renders continuously, and each of those renders re-highlights. A test that drives N
scripted re-renders and counts calls cannot see the first one.

#### What the probe has eliminated

`scripts/fixtures/transcript-highlight-probe.{html,jsx,css}` renders the real `MessageList` over an
82-message transcript in a real browser and counts `highlight.js` calls over **wall clock**. Each
run verifies `getComputedStyle(row).contentVisibility === "auto"` first — the fixture's first
revision measured `visible`, because Tailwind scans from the Vite root and never read `src/client`,
so every number was a false negative until an explicit `@source` fixed it.

| condition | extra `highlightAuto` calls |
|---|---|
| 6 s idle after mount | **0** |
| 5 s of continuous scrolling | **0** |
| 6 s idle immediately after that scrolling | **0** |
| 20 forced `MessageList` re-renders | **0** |
| every `ChatMessage` object replaced | **0** |
| diff modal opened (inline body) | 1, then **0** over 9 s idle |
| diff modal opened (docs/244 stripped body) | 1 fetch, no retry, **0** highlights |

So the loop's engine is **not** in `MessageList`, the memoized rows, `SubagentReport`'s
`useOverflows` ResizeObserver, the `content-visibility` pairing, or either lazy-body fetch
(`useLazyToolInput` and `useLazyResultBody` both cache their error under the same key, so neither
can retry).

#### What the payload size says about the surface

The probe fixes each call site's input size, which is how a measured duration names a surface.
`WriteContent` highlights a **whole file body, untruncated** — 16,979 bytes for the 400-line
fixture, which is the trace's ~274 ms. `ReadResult` highlights only its `READ_MAX_LINES` (20-line)
preview, ~46 ms, *unless the user expanded it*. So the traced payload is a whole ~400-line file:
`WriteContent` in a diff modal, an **expanded** `ReadResult`, or a fenced block holding a whole file.
That also disposes of the original suspicion that scrolling reached `ToolResult` — `ToolResult`
renders only inside `ToolCallModal` and `WriteContent` only inside `DiffModal`, so neither is
reachable by scrolling at all.

**No modal was open during the recording** (confirmed by the user who took the trace, 2026-08-30).
`ToolResult` renders only inside `ToolCallModal` and `WriteContent` only inside `DiffModal`, so both
are excluded outright, and **`CodeBlock` is the only call site left**. Two things follow:

- The block is a **fenced code block in the transcript holding a whole ~400-line file**, with no
  language on the fence or one `hljs.getLanguage()` does not know — that is the only way `CodeBlock`
  reaches `highlightAuto` rather than the cheap `hljs.highlight` path.
- `CodeBlock` is memoized and its `useMemo` compares strings by value, and the probe shows it does
  not re-highlight under re-render or message-object churn. So the loop **remounts transcript
  rows** — roughly 29 times, ~284 ms apart. There is no remaining reading in which it merely
  re-renders them.

The probe already shows nothing *inside* `MessageList` does that, and that replacing every
`ChatMessage` object does not (element reuse plus the row memo hold). **Row-key churn is now
eliminated too**: inserting and removing a leading message shifts every bubble's `m-${el.index}`,
but React reconciles keyed children across the whole list, so the key *set* changes only at its
ends — each fiber is reused and re-rendered with the next row's props. Six flips produced **0**
`CodeBlock` mounts. That leaves the remount being driven from **above** `MessageList`: the
whole-transcript paths listed earlier, or something else in the chat panel that unmounts it.

#### The 1.8 s cadence, and what it is not

Before the continuous burst the heavy calls are isolated and roughly evenly spaced — 3 at ~0 ms, 2
at ~1,874 ms, 1 at ~3,649 ms — then continuous from 6,626 ms to 14,860 ms. Something on a ~1.8 s
cadence appears to remount transcript rows, and then stops being periodic and self-sustains.

**A periodic re-render cannot be it, whatever its cadence.** Driving the probe with a re-render every
1 s for 8 s — the cadence of the real timers, `GitHubRateLimitBanner` and `useContainerHealthPoll`,
both of which force a render every 1,000 ms — produces **0 block mounts and 0 highlights**. Since
only a remount can re-highlight, no timer that merely re-renders can be the engine.

Eliminated by inspection in the same pass, each for a structural reason rather than a measurement:

- **`@formkit/auto-animate`** (docs/265's own 2 s per-element interval, the closest cadence in the
  codebase) is used in exactly one place, `SessionSidebar/SessionGroup.tsx` — a *sibling* of the chat
  panel, not an ancestor of `MessageList`. It cannot remount the conversation.
- **Keyed ancestors**: the only `key=` in `App.tsx`/`AppLayout.tsx` are on `RepoTrustBanner` and
  `SessionSettingsDialog`. Neither is an ancestor of the conversation.
- **`useNarrowContainer`** — the one container-width boolean that could oscillate against its own
  layout — is used by the Issues panel only.
- **History rehydration** is out on the trace's own evidence: `/history` was fetched exactly once in
  the window, and the whole trace contains three requests (`/api/events`, `/files`, `/history`).
- **A resize-driven breakpoint flip** is out: the trace has zero resize events of any kind. A
  `matchMedia` change does not surface as a DOM event, so that route stayed open on the event
  evidence alone — but the **viewport measurement closes it**. The trace's full-page `Paint` clip is
  `[0,0,2742,0,2742,1906,0,1906]` at the metadata's `hostDPR: 2`, i.e. a **1371 × 953 CSS px**
  window. `useIsMobile()` is `(max-width: 767px)`, so the query was stably false by a factor of 1.8
  and nothing resized. **The `isMobile` flip below cannot have fired during this recording**, let
  alone 29 times.
- **Click and focus** are out, and this corrects an earlier reading of the same trace. `focus`,
  `focusin` and `DOMFocusIn` each fire **exactly once**, all at 7,172.2 ms — **546 ms after** the
  burst began at 6,626 ms — and the trace contains exactly one click, at 7,175 ms, into a text field
  (`focus` + `selectstart` + `click`): the user reaching for the composer before typing. An earlier
  pass reported a `focusin` immediately *before* the burst; that came from a windowing bug in the
  analysis script, and direct enumeration of every focus event in the trace refutes it. Both the
  click and the five keystrokes that follow sit **inside** an already-running loop, so they are
  victims of it, not triggers.
- **SSE** is out: `/api/events` opened and delivered zero messages.

#### The remount class is mitigated, measured rather than argued

`AppLayout` renders `isMobile ? <>…</> : <div>…</div>` — a Fragment against a div at the same
position, which React treats as a type change and so unmounts and remounts everything beneath,
`chatPanel` included. The probe reproduces that exact shape (`window.__swapWrapper`), which doubles
as the **positive control** for the mount counter: without it, every "0 mounts" above would be
unfalsifiable, since a counter that can never report a mount reports zero for free.

**This is a real latent defect and a separate finding from the trace.** The viewport measurement
above rules it out as *this* recording's engine, so it is not the answer anyone was looking for —
but it stands on its own: every crossing of the 768 px breakpoint discards every fiber in the
transcript and re-highlights every code block in it. Resizing a desktop window across the
breakpoint, or rotating a tablet, is enough. The fix is to give both branches the same element type
so React reconciles instead of remounting; the mobile branch's relative wrapper is load-bearing
(it scopes the sessions drawer overlay to the content region above the tab bar), so it has to
survive the change.

Four flips of that wrapper, with the big block in the transcript:

| | block mounts | highlight runs |
|---|---|---|
| cache neutered | 3 | **3** (16,979 bytes each) |
| cache live | 3 | **0** |

So the remount *class* — the one the trace's surface and payload point at — costs nothing once the
answer survives the fiber. That does not name the engine, and this section does not claim to.

Measuring that needed a third correction to the instrument, for the same reason the guard test did.
**Counting `highlightAuto` can no longer detect a remount at all**, because `highlightCached` turns
one into a map lookup — the fix blinds the obvious probe. The probe now counts `code.hljs` nodes
entering and leaving the DOM, which is independent of the cache.

#### The rule this investigation kept relearning

Four instruments in this work were blind by construction, and each produced a confident negative
before anyone noticed:

1. A fixture built outside Tailwind's content scan rendered `content-visibility: visible`, so the
   browser was never doing the thing under test.
2. A patched `addEventListener` counted *calls*, over-reporting because the DOM deduplicates
   identical `(type, listener, capture)` triples and `once: true` listeners self-remove — it
   reported a per-keystroke "leak" the browser was not holding.
3. Patching the full `highlight.js` build intercepted nothing, because the code calls
   `highlight.js/lib/core`, so the counter read 0 forever and every elimination was a false
   negative.
4. Counting `highlightAuto` stopped detecting remounts the moment a cache made one a map lookup.

**The rule: a negative result is worth nothing until the instrument has been shown able to produce a
positive one.** Assert the condition under test is actually present (computed style, a non-zero
baseline at mount, a positive control that forces the event you are counting) *before* believing any
zero. `window.__swapWrapper` exists for exactly this reason. Note that (2) cut the opposite way from
the others — a blind instrument can over-report as readily as it under-reports, so "the number
looked alarming" is not evidence the instrument worked either.

Scaling the listener count is a weak but consistent cross-check: this fixture registers ~2 listeners
per rewind handle and ~1.9 per message at mount, so 620 per iteration is far more than any single
row and is the order of a large subtree — which is what a key-churn remount of the row list would
be. Treat that as a sanity check on the shape, not as arithmetic: it scales a synthetic fixture to a
real session.

#### The listener rise is registration churn, not a leak

The same trace showed live listeners rising by **exactly 620 per highlight call** while DOM nodes
grew by 8 over the whole 15 s. That figure survived falsification: with 2,131 counter samples for 35
calls, growth tracks the calls and not the clock — 2,264 listeners/s across intervals overlapping a
heavy call against 118/s elsewhere, and a 2.7 s quiet window holding 819 samples and no heavy calls
grew by **exactly 0**. So ~620 registrations per iteration is real, and since `highlight.js` attaches
no listeners, they belong to whatever is being mounted each iteration.

**They are not known to be retained, and an earlier draft of this section was wrong to imply it.**
The reading that they "never fell across several garbage collections" does not hold: the trace
contains 163 minor GCs, all scavenger, and **zero** major / mark-compact events. Detached nodes and
their listeners are released by a major GC, so the collections that ran were never going to release
them. A subtree that mounts and unmounts every iteration produces exactly this curve and is
reclaimed by the first major GC — which a 15-second window never saw.

That is why the probe finding no retention below is **evidence, not a gap**: it is what the trace
predicts if the 620 are churn. The open question is what mounts them, not where they leak.

The probe gained a listener counter to answer that, by patching `EventTarget.prototype`.

**A counter that counts `addEventListener` CALLS reports a leak that is not there.** Two DOM rules
make calls and registrations different numbers, and both inflate the answer:

- **Deduplication.** `addEventListener` with the same `(type, listener, capture)` triple is a no-op.
- **`once: true` auto-removal.** Such a listener detaches when it fires, with no
  `removeEventListener` call for a patch to observe.

Both matter here, because `@radix-ui/react-menu`'s keyboard-vs-pointer tracker re-adds one stable
`handlePointer` under `{ capture: true, once: true }` on **every keydown**
(`react-menu/dist/index.mjs:59-63`). The naive counter reported +160 live listeners per keystroke in
an 80-gap transcript, and a per-cycle "leak" of +159 from opening and closing the diff modal. Both
were the instrument. With the counter corrected to model dedup and `once`:

| measurement | corrected result |
|---|---|
| one keystroke, 80 rewind handles mounted | +160 (2 per handle), **plateaus** — further keystrokes add 0 |
| a pointer event after that | the 80 `pointermove` fire and self-remove |
| diff modal opened and closed, cycles 2 and 3 | **exactly 0** net; DOM nodes flat at 2,756 |
| one keystroke with `?rewind=0` (no handles) | **0** |

So the keydown cost is real but **bounded and self-clearing** — at most two document listeners per
mounted `RewindPoint`, cleared by the next pointer event. The `?rewind=0` control is what attributes
it to the rewind handles rather than assuming it: with them the keystroke costs 160, without them it
costs nothing.

That also **explains the trace's outliers**. Deltas over the 620 baseline were +73, +108, +113 and
+116, in the windows where a keystroke landed; at two listeners per handle that implies 37–58 rewind
handles, which is plausible for the traced session's 14,524 DOM nodes. The outliers are the rewind
handles; the 620 baseline is separate and stays open.

**Nothing reachable in the transcript, the diff modal, or a keystroke RETAINS listeners** — and, per
the GC reading above, that is the expected result rather than a missing explanation. DevTools'
`JSEventListeners` counts registrations, not calls, so the production figure is not subject to the
call-counting error either. What remains unidentified is the subtree whose mount registers ~620.

### 2c. Always-on animation steps on a 10 Hz grid (req 13)

A page holding a live `IntersectionObserver` runs the whole main-thread rendering lifecycle on
every frame the browser *schedules*, and a running animation schedules one per vsync. ShipIt
always holds such observers — Chrome makes one internally per `content-visibility: auto`
transcript row, `@formkit/auto-animate` makes more, and so does every inline Present card — so a
single ever-running indicator cost an **idle** session ~118 ms of main thread per second. That
is the reported "25% of a core on a session where nothing is happening".

`checklist.md` had this recorded and left unfixed, because it read the choice as being between
the two observer sources and both are load-bearing. **The animation is a third ingredient and
the cheap one**: with it stopped, 2,000 `content-visibility` rows plus a live observer cost
0.1 ms/s — the same as removing both observer sources, from moving one thing instead of two.

Two changes, and they compose.

**Steady states stop animating.** `ServiceList` and `PreviewServicesDrawer` drew a *running*
service with `animate-ping`. A service that is up is not in-flight work, and that ping ran for
as long as the service did — which is how a session with nothing happening had something
animating. `starting` keeps its spinner. An audit of the other infinite animations found no
second case of the same mistake.

**Everything still animating steps at 10 Hz.** `steps(N)` wakes the main thread only when the
value changes, N times per iteration rather than 60 times a second, and the frame rate is
measured to scale exactly with N. `--animate-spin`, `--animate-ping` and `--animate-pulse` are
re-declared in an `@theme` block; `.tool-spinner`, the rocket scene and the preview-art
illustrations take `steps(duration ÷ 0.1s)`.

Two measured constraints make this a rule enforced by a test rather than a convention:

- **The cost is the union over running animations.** One un-stepped animation puts the whole
  page back at display rate, cancelling the saving from every other one.
- **Step boundaries run from each animation's own start time**, so a delay off the grid gives
  that element its own tick train and the costs add — two `steps(10)` animations mounted 37 ms
  apart cost 15 frames/s, not 10.

`index.animation-policy.test.ts` checks both over every `animation:` shorthand and every
`animation-delay` in `index.css`.

Not changed: `content-visibility: auto`. Its benefit is now measured rather than assumed — it
**halves first contentful paint** on a 2,000-row transcript (123 ms against 227 ms) — so the
trade the old decision rule was about no longer has to be made. The same measurement found it
makes a full-transcript scroll 3.5x *more* expensive, which is a separate open finding.

Numbers, and what this does not fix, are in
[`checklist.md`](./checklist.md#fixed-2026-09-01--the-third-ingredient-nobody-had-varied).

### 3. Revalidate instead of re-download (reqs 10, 11)

`GET /api/sessions/:id/history` gains an **ETag that is the hash of the response body**, and
honours `If-None-Match` with a `304`. The client keeps a small bounded per-session cache of
the last parsed response and sends the ETag it holds.

The ETag is the body hash rather than a composed version stamp on purpose: the payload is
built from seven independent sources (chat rows, git log, file tree, runner state,
background tasks, usage, presentations), and a stamp that misses one serves a stale
transcript — exactly what req 11 forbids. Hashing what is about to be sent cannot be wrong.
It saves the transfer and the client-side parse and store writes, not the server-side build.

### 4. Stop shipping the file tree with the transcript (req 12)

`fileTree` is 325 KB of this repository's 2.67 MB payload (2,847 files, 505 directories) and
has nothing to do with chat history. So `/history` stops returning it, `GET
/api/sessions/:id/files` gains an ETag of its own, and the attach path fetches the tree from
there.

**That fetch is issued and applied by `loadSessionHistory`, not fired off into the file
store.** Delegating to `useFileStore.fetchTree` was the first attempt and review found it
wrong twice over: the store's setter has no session check, so a slow response for the
*outgoing* session lands after a switch and overwrites the incoming one's tree; and a tree
that arrives strictly after the transcript leaves the Files panel saying "No files yet" for
the gap. Both disappear when the tree rides the load it belongs to — started in parallel with
the history request, awaited inside the same `isStillActiveSession()` guard that already
protects every other write in that function, and tolerant of failure so an unreachable tree
can never cost the user their transcript.

### 5. Cancel a superseded history load — delivered (req 8)

`historyLoadSeq` made a superseded response harmless but not free: the body was still
downloaded and `JSON.parse`d before the guard dropped it. `loadSessionHistory` now aborts the
load it supersedes.

Deliberately *not* the shared-promise approach the work item first proposed: a second load
exists precisely because the socket the first was issued for is gone
(`useConnectionSync`'s `closed`/`connecting` branch frees the next open to issue its own), so
chaining the fresh load onto a dead request would hang the transcript behind a fetch that may
never settle. The seq guard stays as well — `abort()` races a response already being applied,
and it is the guard that makes out-of-order application impossible.

## Key files

| File | Change |
|---|---|
| `src/client/components/MessageList/MessageList.tsx` | Rows extracted to a memoized component; volatile values behind a ref context |
| `src/client/components/MessageList/TranscriptRow.tsx` | New — the memoized row |
| `src/client/components/visual-elements.ts` | Reconcile pass for stable element identity |
| `src/client/utils/session-data.ts` | Abort-on-supersede (done); ETag cache; file tree no longer read from `/history` |
| `src/server/orchestrator/api-routes-session-spawn.ts` | `/history` ETag + `304`; `fileTree` removed |
| `src/server/orchestrator/api-routes-files.ts` | `/files` ETag + `304` |
| `src/client/hooks/useSearch.ts` | Shared empty match array, so no-search stops invalidating every row |
| `src/client/utils/highlight-cache.ts` | New — bounded LRU so a highlight survives a remount or an abandoned render |
| `src/client/components/message-markdown.tsx` | `CodeBlock` highlights through that cache |
| `src/client/utils/doc-paths.ts` | `DocIndex` — two linear passes replace the per-doc list scans behind the Docs-tab freeze |
| `src/client/components/DocsViewer.tsx` | Groups through that index, memoized on the doc list |
| `src/client/index.css` | The 10 Hz rule: `@theme` overrides for Tailwind's always-on utilities, `steps()` on every other infinite animation |
| `src/client/index.animation-policy.test.ts` | New — enforces the rule over every infinite animation and every delay |
| `src/client/components/ServiceList.tsx`, `PreviewServicesDrawer.tsx` | A running service is a steady state and stops animating |
| `scripts/trace-load-and-scroll.mjs` | New — traces from before navigation, so what `content-visibility: auto` BUYS can be measured |
| `scripts/fixtures/inject-app-spinner.js` | New — drives a real page with the app's own animation classes, reporting each resolved `animation` as its positive control |

## Verification

Re-record a DevTools trace of a streaming turn on a long session and compare against the
table at the top: the render slices should collapse from 46 × 92 ms to a small number of
short ones, and no task should hold a chain of them. Then check by hand that Ctrl+F finds a
message far above the fold, that select-all copies the whole conversation, that the
transcript stays pinned while a message streams, and that search jump-to-match still scrolls
and highlights.

## A larger cost now dominates, and this design does not address it (2026-08-30)

A production trace taken after this work shipped is recorded in
[`checklist.md`](./checklist.md). It does not close reqs 1–4 — it is not a streaming turn —
but it establishes that the render cost this doc is about is no longer the largest one.

**`hljs.highlightAuto()` is 52% of that trace**: 7,786 ms of self time in the `_highlight`
leaf, 8,847 ms across the whole highlight.js module, out of 14,897 ms. It runs synchronously
inside a React render, so it blocks exactly the way the 92 ms slices did.

The mechanism is unrelated to row memoization. `highlightAuto` is not told which language the
text is, so it highlights the content once per registered language — all 192 of them — and
compares relevance scores. Browser-measured on 12 KB: 248.9 ms for all 192 languages, 19.6 ms
for a 13-language subset, 4.1 ms when the language is known. Two of the three call sites can
know the language and do not (`ToolResult.tsx`, `DiffBlock.tsx`).

**This matters for reqs 1–4 rather than being merely adjacent.** Cost per call is
near-constant (p50 274 ms, p90 276 ms) while `highlightAuto` cost scales with input size — so
one payload is being highlighted ~35 times, which is a memoization or remount failure of the
same family this design set out to remove. Whether the row memo is implicated is not
established here; only 12 WebSocket frames arrived, so nothing was streaming, and the trace
shows scrolling instead. Tracked separately.

## A second, separate highlight cost: one 8.3 s call (2026-08-30)

A different trace the same day (17.3 s, main thread busy 10.8 s) holds a **single**
`FunctionCall` of **8,264 ms** with 162 minor GCs inside it — one uninterrupted synchronous
`highlightAuto`. That is not the loop above and nothing in this design addresses it: the loop
is 35 repeats of one ~274 ms payload, this is one call that never returns in time. Neither
the row memo nor `highlightCached` can help, because the *first* call is already too slow.

The cause is per-grammar, not per-call: `c`, `cpp` and `csharp` are **quadratic in input
length** on prose-like text — measured on repeated punctuation-free English, auto-detecting
over all 27 registered grammars costs 537 ms at 5.2 KB, 1,367 ms at 10.4 KB, 5,490 ms at
20.8 KB and 21,088 ms at 41.6 KB, while the other 24 cost 32 / 89 / 230 / 696 ms. On 15.6 KB
they are cpp 1,539 ms, c 1,574 ms, csharp 1,327 ms against 138 ms for all 24 others combined.
The full 192-grammar build costs 8,747 ms on 20.8 KB, which both matches the traced 8,264 ms
and shows this **predates** the subset change rather than being caused by it — bounding the
set made it strictly better, just not better enough.

Fixed by splitting the auto-detect set from the registered set (the three stay registered, so
an explicit ` ```c ` fence still highlights) and capping auto-detection at 12,000 characters
as a backstop against the next such grammar. See `src/client/syntax-highlight.ts`.

The payload was a large unlabelled code block, ~20-30 KB inferred from the curve above rather
than captured. Which surface supplied it is **not** settled — the docs tab was open, but
`/api/sessions/:id/docs` returns metadata only and `DocsViewer.tsx` highlights nothing, so the
docs list cannot be the source; the chat transcript is the only surface that loaded a large
body in that window.

## The Docs tab froze the UI, and it was never the transcript (2026-08-30)

Reported with a reproducible trigger the earlier rounds did not have: **opening the Docs tab freezes
the UI; with any other right-hand tab open it does not.** That is a strong constraint, because only
one thing in the app is conditional on it — `App.tsx`'s `rightTab === "docs"` branch renders
`DocsViewer`, and no other tab does.

`DocsViewer` grouped its list with three predicates that each take the whole doc list and answer by
scanning it. `hasTrackedSibling` scanned it once **per candidate sibling**, because it called
`isTracked` — itself a scan — *before* the cheap same-directory test. Asked about every doc, that is
**O(u²·n)** over n docs of which u are untracked. It ran in the render body, unmemoized.

Measured in Chrome over this repository's real doc list (n = 866, u = 96), three runs:
**486 / 356 / 342 ms per render**. Indexed: **3.6 ms**, and the grouping output is byte-identical on
the real list.

The rate is what turns that into a freeze. `DocsViewer` is created inline in `App`'s `rightPanel` and
is not memoized, so it re-renders on every `App` render — and `App` subscribes to `messages`
(`App.tsx:199`), so every update to the transcript is one. How many that is per second is
backend-dependent (the Claude adapter maps CLI assistant events rather than raw deltas), but a
streaming reply produces many, and each one cost ~400 ms of synchronous string-slicing while the
Docs tab was open. With any other tab: zero, because the branch is never rendered.

The fix is two linear passes: `buildDocIndex` (`utils/doc-paths.ts`) precomputes per-directory facts
— which directories hold a `plan.md` or a `checklist.md`, and how many tracked docs each holds — and
the predicates become `Set`/`Map` lookups taking that index, built once in a `useMemo` keyed on the
list. The index counts each tracked *path* once rather than each entry, because the scan it replaces
excluded every entry matching the queried path; the two agree only while paths are unique, which
`listDocs` guarantees but the utility's contract did not.
The `(path, entries)` convenience forms are **deleted rather than kept**: a predicate that accepts
the list reads as free at the call site and hides the scan, which is exactly how a per-doc call in a
render body became O(u²·n) unnoticed. Their only remaining caller was the defect.

**This is a different finding from the highlight loop above, and it does not close it.** The
2026-08-30 12:00 trace's 8,264 ms leaf was read by another session and attributed to
`hljs.highlightAuto`; that trace was not available to this work, so whether that leaf is this cost or
a second one is **unestablished**.

The precise statement, which an earlier draft of this section overstated: **the `DocsViewer`
grouping subtree does not call `highlightAuto`**, so an `_highlight` leaf would be a separate cost
from this one. It is *not* true that `highlightAuto` is unreachable while the Docs tab is open — the
transcript stays mounted beside `rightPanel`, and opening a doc renders its markdown through the
same `markdownComponents` → `CodeBlock` path. What the trigger rules out is only that the *grouping*
is what a highlight frame would be measuring.

Worth knowing when the next trace is read: this cost and a highlight both present as one
multi-second synchronous `FunctionCall` inside a component render, and `dirOf`/`isTracked` are small
enough that a release build inlines them, leaving an anonymous arrow as the visible frame. Reading
the leaf name is therefore what distinguishes them, not the shape.
