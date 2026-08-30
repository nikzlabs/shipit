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
