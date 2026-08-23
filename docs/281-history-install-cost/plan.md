---
issue: planning#467
title: What a validated 304 on /history may and may not do — design
description: The 304 install stays unconditional; its per-row re-materialization is memoized on the cache entry so the transcript's memo bails out.
---

# 281 — What a validated 304 on `/history` may and may not do: design

Implements [`requirements.md`](./requirements.md). Requirements are cited as `(req N)`.

## Finding 1 — the ordering is guaranteed; the one real hole is elsewhere (req 1, req 2)

The install in `loadSessionHistory` is a wholesale replace, and during a running
turn the payload is a strict **subset** of what is on screen: the in-memory array
also holds everything the turn streamed since its last persist boundary. The gap
closes by construction, through a chain that is deliberate at every link:

| Step | Where | What it guarantees |
|---|---|---|
| The reconnect lowers `historyLoaded` | `useConnectionSync.ts:203` (`closed`/`connecting`), `session-actions.ts:105` (switch) | The flag is false for the whole of the load |
| `turn_snapshot` is queued while it is false | `useMessageHandler.ts:73-79` | The snapshot cannot land *under* the baseline |
| The attach sends a fresh snapshot whenever the runner is running | `route-registry.ts:1070` | There is always a snapshot to restore the tail |
| The install runs, then raises the flag | `session-data.ts` — `setMessages` strictly before `setHistoryLoaded(true)` | The drain is ordered after the install |
| The drain replaces the in-progress rows | `turn-snapshot.ts:51` | The tail is restored whichever order the wire delivered |

So for the path planning#467 names — a foreground reconnect during a running
turn — the window is **closed**, and closed by design rather than by luck:
`useMessageHandler`'s queue exists for exactly this. And **none of it is specific
to the `304`**; the `200` path reaches the same install by the same route with
the same guarantee. The link that was not pinned end-to-end on the cached path is
the last two rows of that table, because a `304` reaches the install without
parsing a body. That is now a test (req 5).

### But row three does not always hold, and there the tail IS lost

The whole chain rests on *there being an attach*. One path has none.

`resumeSessionInternal` clears the transcript and lowers `historyLoaded` for the
incoming session. When the "incoming" session is the one **already on screen**,
the session id does not change — so `useSessionWebSocket`'s memoized URL does not
change, no socket is built, and the server never attaches. No `turn_snapshot` is
coming. Hydration re-runs (correctly, keyed on the flag) and installs the
persisted rows over a transcript whose unpersisted tail has already been thrown
away. It stays gone until a genuine reconnect or a reload.

It is one click away: `AllSessionsDialog` renders every row with
`isCurrent={false}`, so the session you are looking at is selectable in the
switcher like any other.

Note **what** loses the tail: the `setMessages([])` in the reset, not the
install. Skipping the install on a `304` would not have saved it — which is a
second, independent reason the conditional-install approach does not answer this
issue's question 1.

**Fix:** `resumeSessionInternal` returns early when the requested session is
already the current one. Every store it resets is scoped to the session being
resumed, so on that path the whole body is either a no-op or destructive; there
is nothing for it to do. The URL-driven caller already guards this way
(`useSessionActivation.ts:84` tests `urlSessionId !== sessionId`); the guard just
moves into the function whose body assumes the change.

**Not covered, deliberately:** the install still *transiently* rewinds the
transcript for the frame between `setMessages` and the passive-effect drain. It
is pre-existing, identical on a `200`, and self-heals. Removing it means making
the install a merge rather than a replace — the question planning#268 (windowed
history loading) re-opens on its own terms.

## Finding 2 — the seeds correct a different channel, and must be unconditional (req 3)

The four seeds are not a consequence of the transcript changing. On every attach
the orchestrator replays the turn-event buffer, and that replay skips only
`agent_event`, `turn_snapshot`, `log_append`, the terminal messages and
`background_tasks` (`route-registry.ts:1112-1137`). **Card messages go through.**
A replayed card lands via its store's `upsertCard`, which writes an absent card
in its fresh, actionable state — `pending` for permission and egress, `draft` for
a bug report, and whatever the wire message carried for an issue write — and only
the authoritative seed restores the persisted phase.

So "the transcript is unchanged" says nothing at all about what the replay just
wrote into the card stores. The `304` is not a licence to skip them (req 4), and
they now live in their own named step, `seedCardStoresFromHistory`, whose
docstring says why and whose guard test fails if anyone conditions it.

Today's `upsertCard` is non-clobbering, so a card that survived in memory cannot
in fact be demoted by a replay. That is a second line of defence, not the first,
and the seed does not depend on it.

## The change: the cost, not the condition (req 5)

The install's real price is not the payload — planning#375 already removed the
transfer and the parse. It is `data.messages.map(...)`, which allocated a fresh
`ChatMessage` for **every row on every load**. `TranscriptRow` takes its message
as the `anchor` prop — "the row's catch-all change signal" — so a fresh object
per row is a memo miss per row, and the whole transcript re-renders: the
**92 ms over ~2,000 rows** that planning#375's memo work
(`visual-elements.ts:reuseUnchanged`, `transcript-row-memo.test.tsx`) exists to
avoid. A foreground reconnect paid it on every alt-tab, and planning#324 made
those revalidations cheap and therefore more frequent.

On a `304` the payload object *is* the one already in the cache, so the rows it
produces are a pure function of an object we have already mapped. So the map is
memoized onto the cache entry (`HistoryCacheEntry.materialized`):

- **Reconnect on an unchanged session** — `setMessages` is handed the identical
  array, `useSessionStore((s) => s.messages)` compares it with `Object.is`, and
  **nothing re-renders at all**.
- **Switch-back** — the array was cleared, so the install genuinely runs, and
  the rows do re-render: the clear unmounted them, so there is no memo to bail
  out of. What is saved here is only the per-row allocation, not the render.
- **Fresh body** — `remember` replaces the entry, and the memoized rows go with
  it. A moved ETag can never reuse stale rows.
- **No ETag** — no cache entry, so a fresh map, exactly as before.

### Why not skip the install

Skipping it on a validated `304` (PR #2550's `historyBaseline` marker) reaches
for the same cost and gives up more than it gains:

- **The install carries guarantees beyond the transcript's content.** It is the
  switch-back baseline restore, and it is what wipes client-only rows — notably
  `useConnectionSync.ts:245`'s "connection lost while the agent was responding"
  notice. Skip the install and that notice survives a brief reconnect during a
  running turn, stranded mid-transcript under a snapshot that contradicts it.
- **The marker's validity is not local.** It is detached on a plain-array
  `setMessages` and kept on a functional one — but `rewind-complete.ts:24` is a
  *functional* update that truncates. It happens to be safe only because a
  rewind also moves the server's transcript revision, i.e. the marker's
  correctness rests on a fact in a different process. Every future
  `setMessages` caller inherits that obligation, and nothing enforces it.
- **With the memoization in place there is nothing left to buy.** A skipped
  install and an identical-array install cost the same: no re-render. Per
  CLAUDE.md's "would anyone notice if it were removed?" — no.

The one thing the memoization assumes is what the client already does
everywhere: rows are immutable, and every handler rebuilds with `{...m}`. A row
mutated in place would now persist into the next install rather than being
discarded by a re-map.

## Key files

- `src/client/stores/actions/session-actions.ts` — `resumeSessionInternal`'s
  same-session early return (req 2).
- `src/client/utils/session-data.ts` — `materializeTranscript` (the memoized
  map), `seedCardStoresFromHistory` (the extracted, unconditional seed),
  `HistoryCacheEntry`, and the install site's docstring carrying finding 1.
- `src/client/utils/session-data.test.ts` — identity across a `304`, restore
  from the same rows after a clear, fresh rows on a moved tag, per-session
  isolation, and the seed running on a `304`.
- `src/client/hooks/useConnectionSync.session-switch.test.tsx` — finding 1
  end-to-end on the cached path, with the response held so the attach snapshot
  genuinely races the load; and the same-session-resume tail loss (req 2). Two
  neighbouring tests used a same-session resume as their vehicle for "the flag
  was lowered without moving the socket"; they now lower the flag directly,
  because that resume is a no-op. The property they pin is unchanged.

## Taken from the inherited branches

- **PR #2552 (`shipit/iapm0-`)** — its conclusion (leave the install alone), the
  `seedCardStoresFromHistory` extraction, and the switch-back objection that
  rules out the naive skip.
- **PR #2550 (`shipit/p6m-rm`)** — its premise, that the redundant re-install is
  real work worth removing, and its 304-path test scenarios. Its mechanism (a
  `historyBaseline` field on the session store) is not taken.

The same-session-resume hole (req 2) came from neither: it was found by the
independent reviewer against an earlier draft of this doc, which asserted the
window was closed on every path.

## Not in scope

- A ghost card-store entry left when a load's payload no longer contains a
  previously seeded card — planning#471. Pre-existing, identical on a `200`, and
  invisible (a card renders only from its transcript row).
- Making the install a merge rather than a replace, which would also remove the
  transient one-frame rewind — planning#268.
