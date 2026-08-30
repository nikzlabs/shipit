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
  `IntersectionObserverController::computeIntersections`, `Layerize`, `Commit`). An
  `EventDispatch type=focus` / `focusin` pair sits in the gap immediately before the burst's first
  call.

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

Measuring that needed a third correction to the instrument, for the same reason the guard test did.
**Counting `highlightAuto` can no longer detect a remount at all**, because `highlightCached` turns
one into a map lookup — the fix blinds the obvious probe. The probe now counts `code.hljs` nodes
entering and leaving the DOM, which is independent of the cache.

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
