# 295 — Implementation checklist

Design: [plan.md](./plan.md). Requirements: [requirements.md](./requirements.md).

## First — settle the one unproven thing

- [x] Establish in code whether a compaction spawn can run in a turn's pre-spawn
      phase without the executor treating its completion as the user's turn
      finishing (`agent_result`, the `done` path, the post-turn commit
      sequence). **Answer: a bare pre-spawn spawn cannot** — the SSE relay
      routes worker events only through the runner's single `_agent` slot, and
      every terminal path drains the queue. It runs as a `postTurn: "none"` +
      `systemTurn: true` TURN instead, the mode the rebase driver already uses.
      Written up in plan.md → "What the step actually does".

## The shared step

- [x] New `orchestrator/pre-turn-compact-hook.ts` — decide, run one compaction
      turn, await its settlement, return an outcome.
- [x] Return an **outcome**, never bare completion: `failed`, `compacted`, or
      `no-compaction` (the backend accepted the trigger and did nothing).
- [x] Give the compaction the post-merge instructions in its prompt; Claude and
      Grok honour them, Codex and OpenCode ignore them (docs/276).
- [x] Do not persist a user row or echo a `/compact` bubble for the step.
- [x] Never let the outcome gate the turn that follows (req 9) — including a
      300 s timeout, so a backend that never settles cannot park the message.

## Wiring both transports (req 13)

- [x] Call it from `ws-handlers/agent-execution.ts`, before `applyPreTurnReset`.
- [x] Call it from `dispatched-turn.ts`, before `deps.preTurnReset` — once per
      dispatched message, **outside `runOnce`**, so a no-result retry does not
      compact twice.
- [x] Apply the same `postTurn: "none"` exclusion the reset uses, so a
      rebase-conflict resolution step never compacts.
- [x] Wire it into `SystemTurnDeps` in `runner-registry-factory.ts`, beside
      `preTurnReset`.

## Wire path for the per-send intent

- [x] `compactContext?: boolean` on `WsSendMessage`
      (`shared/types/ws-client-messages.ts`), documented as non-sticky.
- [x] Carry it through `ws-handlers/send-message.ts` into the turn options.
- [x] Suppress the step when the send is already an `isCompactRequest` (req 12).

## Composer control

- [x] `showCompactControl = showResetControl && supportsCompaction` in
      `MessageInput.tsx` — reads no usage or occupancy state (req 3, req 10).
- [x] Checked by default, non-sticky, re-checked whenever the control reappears
      (req 2, req 5), mirroring `resetChecked`.
- [x] Render as a subordinate line inside the existing control block, not an
      equal-weight second row.
- [x] Put the flag on the send payload only when the control was shown.

## Setting

- [x] Update the description of the existing "Start from the latest base after a
      merge" row in `Settings/tabs/AdvancedTab.tsx` to name both actions. No new
      setting (req 11).

## Tests

- [x] The compaction runs before the reset, and the turn still carries the
      docs/218 merge prefix afterwards (req 7) —
      `dispatched-turn-pre-turn-compact.test.ts`.
- [x] A dispatched continuation compacts under the global setting, with no
      checkbox involved (req 13) — same file, `intent: undefined` asserted.
- [x] A retried dispatched turn compacts once, not twice.
- [x] A `postTurn: "none"` turn never compacts.
- [ ] **A `/compact` send with the control visible compacts exactly once and
      does not reset the branch (req 12).** Implemented — the pre-step and the
      reset share one `!opts.compact` clause in `agent-execution.ts` — but NOT
      covered by a test. The obvious place (`integration_tests/compaction.test.ts`)
      would be blind by construction: its session is not merged, so the hook
      short-circuits on eligibility and the test passes with or without the
      guard. A real guard needs a merged, reset-eligible session in that
      harness. Flagged to review rather than ticked.
- [x] A failed compaction still runs the turn **and** leaves a notice (req 9).
- [x] A compaction that reports no event is not reported as a success.
- [x] The two checkboxes are independent (req 6).
- [x] The control is hidden when the harness cannot compact (req 10) and when
      the global setting is off (req 11).
- [x] The control's visibility does not change with context occupancy (req 3) —
      `showCompactControl` reads no usage state, and the composer tests render
      with none wired.
- [x] Delete each guard singly and watch it fail, so no test passes with the
      defect present. 11 server mutations + 5 client mutations run; one client
      mutation had to be rewritten because req 11 is enforced *structurally*
      (the compaction control is nested inside the reset control's block), so
      the realistic regression is giving the compaction its own setting-blind
      gate — that one does go red.

## Close-out

- [x] `npm run lint:dev` and `npm run typecheck` clean.
- [x] Independent review against every numbered requirement
      (`shipit agent run --role reviewer`), review-only. It found eight defects,
      several confirmed with its own in-memory probes, all in one theme: the
      executor OWNS the runner's turn-lifecycle state and releases it when the
      *compaction* ends, not when the user's message does. `postTurn: "none"`
      suppresses the drain and the commit — it does not stop the turn giving up
      ownership. Fixed below; the remainder is listed as open.

### Fixed from the review

- [x] The session no longer reads idle between the compaction settling and the
      user's turn claiming the runner (the branch reset sits in that window and
      takes seconds, so a message arriving there was ADMITTED — two agents, one
      working tree).
- [x] The compaction no longer erases the outer turn's `activeDeliveryId`, which
      a merge-watch retry supervisor reads to decide whether work is in flight.
- [x] `systemTurnInProgress` is restored even on the timeout path, where the
      executor's terminal sequence never runs. Left set, it suppressed live
      steering for the rest of the session and stranded the queue.
- [x] The timeout now bounds a stall INSIDE the executor (`prepareAgentEnv`,
      `buildRunParams`), not just one after it — the executor's promise is raced
      against the settle latch rather than awaited ahead of it.
- [x] A `createAgent` throw returns a `failed` outcome instead of rejecting the
      hook, which used to skip both callers' executors and lose the user's
      message outright — a direct req 9 violation.
- [x] The compaction stands down rather than killing a resident process that
      holds background work (docs/260 req 13). `dispatchOnRunner` enforces this
      by enqueuing; this hook drives the executor directly and bypassed it.

### Still open from the review

- [ ] **The compaction emits the runner's unscoped `turn_result`**, which the
      outer dispatch's settlement latches as evidence that *its* prompt ran. A
      later drop is then reported as `interrupted` ("do not re-deliver") for a
      user message that never ran. Not local to this hook.
- [ ] **Recovery attempts escape the hook's observation.** The executor may
      replace the agent on auth heal or quota failover; the hook watches and
      kills only the first, so a successful compaction on attempt two is
      reported as `no-compaction`, and a timeout kills the retired process while
      the live one stays installed.
- [ ] **A programmatic continuation misses a merge the reset then discovers.**
      Eligibility is read before `recheckMergeBeforeTurn`, so inside the poll
      window the turn resets without compacting.
- [ ] **The queue drops per-send intent** (`compactContext`, `resetMergedBranch`,
      and the `/compact` classification). Pre-existing for docs/218; this feature
      inherits it, and a queued `/compact` can reach the pre-turn steps without
      `opts.compact`.
- [ ] **The composer keeps an untick across a session switch** — the non-sticky
      effect keys on the visibility boolean, which stays true between two
      already-eligible sessions.
- [ ] Comment the outcome on `planning#522`.
