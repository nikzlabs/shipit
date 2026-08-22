# A validated 304 on `/history`: install and seed conditions

Establishes, from the code, whether the client's `304` handling in
`loadSessionHistory` (`src/client/utils/session-data.ts`) harms the live
transcript or the card stores, and fixes whatever follows from that
establishment. Tracks planning#467.

1. On a `304`, the client must render a transcript identical to what a fresh
   `200` would have delivered — no field of the cached payload may be staler
   than a fresh response.
2. On a `304`, a persisted card must still render in its persisted phase: a
   filed bug report must not come back as an editable draft, a resolved
   permission prompt must not re-offer Approve/Deny.
3. On a reconnect during a running turn, the rows streamed since the last
   persist boundary must survive the history load (transiently hidden at most,
   never lost).
4. Switching back to a session whose transcript did not change must still
   populate the transcript from the cache — the switch cleared it, so "nothing
   changed" cannot mean "install nothing".
5. The transcript install and the card re-seed may carry different conditions
   only if each condition is verified against every caller path of
   `loadSessionHistory` (reconnect, session switch-back, page reload).

## Open questions

(none — see Resolved questions; benchmark rule 1 applies)

## Resolved questions

- 2026-08-22 — **Is the 304 install a live truncation window? (req 3)** No.
  Verified by code reading, not assumed:
  `useMessageHandler.ts` queues `turn_snapshot` while `historyLoaded` is false;
  `loadSessionHistory` raises that flag strictly after `setMessages` in one
  synchronous stretch (`session-data.ts:336` → `session-data.ts:425`, no
  intervening await); the server sends a fresh snapshot on every attach while
  running (`route-registry.ts` `attachToRunner`, reached from every
  `/ws/sessions/:id` open); `handleTurnSnapshot` replaces all `inProgress`
  rows. Full chain in `plan.md` §"Findings". **Benchmark assumption:** none
  needed — this is settled by the code.
- 2026-08-22 — **Should the seeds be skipped when the transcript is unchanged?
  (req 2, the issue's constraint)** Never. The attach-time buffer replay
  delivers buffered card messages to their stores *ahead of* the HTTP baseline
  (card types are not queued behind `historyLoaded`), creating draft/pending
  phases that only the authoritative seed corrects. Skipping on `304`
  reintroduces exactly that failure. Verified at `route-registry.ts`
  (buffer replay loop) and `useMessageHandler.ts` (queue list).
- 2026-08-22 — **Benchmark assumption: what does "fix" mean when both
  establishment questions resolve against the issue's framing?** Per the brief
  ("if part of the reported behaviour turns out not to be a defect, say so
  plainly"), the deliverable is: the established answers written down where the
  next reader will trip, the guarantees turned into pinned tests, and the seed
  step made structurally independent of the transcript install. No behavioural
  change, because none follows from the facts. Tests pin the guarantees and
  fail against the two regression shapes planning#467 warns about
  (skip-seeds-on-304, skip-install-on-304) rather than against current
  behaviour, which this investigation found correct.
