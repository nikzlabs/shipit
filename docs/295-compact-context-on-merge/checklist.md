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
- [x] A `/compact` compacts exactly once and does not reset the branch (req 12),
      on the queued path as well as the immediate one — three tests in
      `dispatched-turn-pre-turn-compact.test.ts`, including a negative control
      (an ordinary message mentioning `/compact` still runs both hooks).
      **Still uncovered on the immediate WS send**, where the two skips share one
      `!opts.compact` clause: the obvious harness is blind by construction (its
      session is not merged, so the hook short-circuits on eligibility and the
      test would pass either way). A real guard there needs a merged,
      reset-eligible session in `integration_tests/compaction.test.ts`.
- [x] A failed compaction still runs the turn **and** leaves a notice (req 9).
- [x] A compaction that reports no event is not reported as a success.
- [x] The two checkboxes are independent (req 6).
- [x] The control is hidden when the harness cannot compact (req 10) and when
      the global setting is off (req 11).
- [x] The control's visibility does not change with context occupancy (req 3) —
      `showCompactControl` reads no usage state, and the composer tests render
      with none wired.
- [x] Delete each guard singly and watch it fail, so no test passes with the
      defect present. 29 server mutations + 7 client mutations run, each failing
      the one test that covers it. Two had to be rewritten because the first
      attempt was unreachable: req 11 turns out to be enforced *structurally*
      (the compaction control is nested inside the reset control's block, so the
      realistic regression is giving the compaction its own setting-blind gate),
      and the first timeout mutation hung the suite rather than isolating the
      defect. Both rewrites do go red.

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

### Second review round — the mechanism was wrong, and was reworked

A second review found six more defects, four P1, again probe-confirmed — and
named the real problem: **owning the agent slot does not require being a turn.**
The first shape ran the compaction through `executeAgentTurn`, and every
remaining piece of the turn lifecycle was wrong for a maintenance step nested
inside someone else's send. Patching them one at a time was the losing move; the
rework collapses most of them.

- [x] **The compaction is now a slot-owning OPERATION, not a turn.** It installs
      a proxy in `_agent`, wires four narrow listeners, calls `prepareAgentEnv` +
      `buildRunParams({compact:true})` + `agent.run`, awaits its own latch, and
      clears the slot. It cannot commit, push, drain, settle, announce readiness
      or publish a delivery — by construction rather than by a flag.
- [x] **`running` stays false throughout**, so no completion is announced for a
      turn that has not run, and `emitChatCard` takes its already-final append
      path — the card is durable when written, with no in-progress rows for the
      user's turn to replace.
- [x] **Admission is held by `preTurnHold`**, a new runner flag mirroring
      docs/288's `mergeHold` at the same three admission points, taken *before*
      the first await. The window that needed closing was never the compaction
      itself but the merge probe and the eligibility check around it.
- [x] **`TurnInput.nestedInSurroundingTurn` is gone**, with its guard. It existed
      only to suppress `turn_result` for the shape that no longer exists — and
      the readiness and delivery signals it did not cover are gone with it.
- [x] **A queued `/compact` is classified on the dispatched drain too (req 12).**
      The send handler classifies an immediate send; one that queued behind a
      merge hold or a dispatched turn drains through `runDispatchedTurn`, which
      knew nothing about it — so it ran both hooks and then handed the CLI the
      literal command behind a merge prefix, without the compaction flag.
- [x] **The spawn is raced against the settle latch**, so a stall inside
      `prepareAgentEnv` / `buildRunParams` cannot park the user's message. (This
      regressed during the rework and was caught by its own guard.)

### Third review round — the slot-owning shape holds; its composition does not yet

The reviewer confirmed the shape is viable ("installing the proxy before `run()`
correctly gives container SSE events a matching run token") and then found ten
more defects, six P1, in how it COMPOSES with the callers around it. Its sharpest
point is about the tests, and it is right: *"the tests split the system at
exactly the failing boundary — isolated hook tests manufacture `running: false`,
while real dispatch tests replace the hook. No test joins real admission, the
real operation, and subsequent history replacement."*

**Fixed here**

- [x] **The compaction card was being deleted by the user's turn.** The design
      claimed `running` is false during the operation; it is not — BOTH callers
      set it before this hook is reached (`send-message.ts` right before
      `runAgentWithMessage`, `dispatchOnRunner` in the same tick as the
      delivery). So `emitChatCard` took the in-progress branch and the user's
      turn deleted the card at its first `replaceInProgress`: rendered live,
      gone on reload. The card is now emitted and appended directly, the same
      route `emitNoticePostTurn` takes. **The harness hardcoded `running: false`,
      so every card assertion was blind** — it now uses the production shape.
- [x] **The spawn discarded the credential route** `prepareAgentEnv` selected.
      It cannot be recovered from the session row (docs/260 §1b threads it as a
      value), so the compaction ran on the service's group credential rather
      than the account routing picked — possibly one routing had set aside.
- [x] **A failed compaction left "Compacting…" up** across the user's whole
      turn. The indicator is now cleared on every exit, not just on success.

**Still open — these are real and this is not mergeable until they are done**

- [ ] **Timing out does not cancel setup.** The un-awaited spawn has no
      ownership check after its awaits, so a `prepareAgentEnv` that resolves
      after the timeout still calls `agent.run()` — into a slot the user's turn
      now owns. In container mode a conflicting start retries and can kill the
      worker's resident agent, i.e. the user's actual turn.
- [ ] **`preTurnHold` is not checked at every admission point.** Programmatic
      steering tries to steer before the hold is consulted; the `answer_question`
      path and the post-attachment recheck in `send-message.ts` check only
      `mergeHold`; the periodic container reconciler ignores it entirely; and the
      hold is released before the branch reset, leaving that window open.
- [ ] **A dispatched queue drain loses delivery ownership during compaction.**
      `drainNext` dequeues the entry but publishes neither its `deliveryId` nor
      `running` until `executeAgentTurn` — so the delivery reads as not-in-flight
      for the whole pre-turn phase, and `preTurnHold` only queues the duplicate a
      supervisor then sends. `agentBusy` and the disposal guard do not include
      the hold either.
- [ ] **Req 12 is still breakable on the dispatched path**: the dependency-gap
      prefix is prepended unconditionally, so `/compact` can still reach the CLI
      as `[System] …run install…` followed by the command — which Grok will not
      recognise in-band.
- [ ] **`/review` drops the composer's opt-out** — `send-handler.ts` builds that
      WS message without `compactContext` or `resetMergedBranch`, so an unticked
      compaction runs anyway.
- [ ] **Credential teardown omits `finalizeAgentEnv`**, so a token the compaction
      CLI rotated just before exit may never be published to sibling sessions.
- [ ] **Run-param assembly consumes pending conversation replay** and the result
      handler writes back every session id without the missing-conversation
      guard, so a failed resume can overwrite a good id with a useless one.
- [ ] **The test strategy needs one integration test** that joins real admission,
      the real operation, and the user's turn's history replacement. Mutation
      counts on isolated units do not establish that the composition is safe —
      finding 1 is the proof, and it survived two rounds of them.

- [x] Comment the outcome on `planning#522`.
