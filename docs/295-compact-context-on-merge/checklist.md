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

**Then fixed — the composition, in one pass**

- [x] **Timing out now cancels setup.** The un-awaited spawn re-checks ownership
      after its awaits (`finished`, and the slot still being this agent), so a
      `prepareAgentEnv` that resolves late abandons the spawn instead of calling
      `agent.run()` into the slot the user's turn now owns — which in container
      mode retries a conflicting start and can kill the worker's resident
      process, i.e. the user's actual turn.
- [x] **`preTurnHold` is asked at every admission point, and spans the whole
      phase.** It moved out of the compaction hook into `withPreTurnHold`
      (`pre-turn-hold.ts`), which both transports wrap around compaction +
      agent-slot resolution + branch reset — the release used to land one step
      early, leaving the destructive half unheld. `dispatchOnRunner` asks it
      BEFORE the steer branch (the reachable defect: during the merge probe the
      resident streaming process is still installed, so a message was steered
      into the process the compaction was about to kill); `releaseQueuedTurn`,
      the `answer_question` path and the post-attachment re-check ask it too; the
      periodic container reconciler stands down under it.
- [x] **A dispatched queue drain owns its turn for the pre-turn phase.**
      `runDispatchedTurn` publishes `running` + `activeDeliveryId` at entry —
      `dispatchOnRunner` already did this for a turn it starts from idle, and the
      DRAINS reached the body without it, so the delivery read as not-in-flight
      for the compaction's whole duration and a supervisor re-sent the prompt.
      Paired with a `catch` that gives ownership back if setup throws.
- [x] **Req 12 holds on the dispatched path**: the dependency-gap prefix is now
      skipped for a `/compact` like the three prefixes beside it, so the command
      cannot reach the CLI behind `[System] …run install…`.
- [x] **`/review` carries the composer's opt-out** — both per-send fields, on the
      one send where the user had just unticked them.
- [x] **Credential teardown calls `finalizeAgentEnv`**, so a token the compaction
      CLI rotated on its way out is published back to sibling sessions.
- [x] **The replay and the resume id are both protected.** A session with a
      conversation replay armed is not compacted at all (`buildAgentRunParams`
      consumes it read-and-clear, so compacting would destroy it); and a spawn
      that hit the docs/153 `--resume` failure does not write its fresh, useless
      session id back. The signature is shared with the turn listeners
      (`missing-conversation.ts`) rather than copied.

**Guards**

- [x] Eleven new tests across five files, each proved red on its own with the
      defect present: the late-spawn abandon, the two `finalizeAgentEnv` paths,
      the replay stand-down, the resume-id write-back, the hold helper's two
      properties, the `/compact` dependency prefix, the hold spanning both hooks,
      the mid-phase steer, the drained turn's delivery, `releaseQueuedTurn`, the
      reconciler stand-down, and the two `/review` frame shapes.
- [x] The mid-phase steer guard had to be rewritten: the first version passed
      with the check removed, because its harness had nothing steerable in the
      slot. It now installs a live streaming process and asserts nothing was
      written to it — which is also the realistic production shape, since the
      window opens BEFORE the compaction retires the resident.
- [x] Two WS admission points are guarded through the real handler
      (`integration_tests/system-turn-queue.test.ts`). The third — the
      post-attachment re-check in `send-message.ts` — is defence-in-depth behind
      the check at the top of the same handler, and is NOT independently guarded:
      producing a hold taken inside that gap needs timing this harness cannot
      make deterministic. Recorded rather than papered over.
- [x] **The end-to-end test the strategy was missing.**
      `integration_tests/pre-turn-compaction.test.ts` joins real admission (a WS
      `send_message`), the real operation (a compaction spawn off a real merged
      git repo, driven by the real hook), and the user's turn's history
      replacement — with a final `GET /history` read AFTER that turn finishes.
      Routing the card back through `emitChatCard` makes it go red, which is
      precisely the defect that passed two rounds of unit-level mutation testing.
- [x] Full suite: 998 files, 17,466 tests. `npm run typecheck` and
      `npm run lint:dev` clean.

### Fourth review round — the composition again, and two backend contracts

A fourth review found nine more, six of them in code the third round's fixes had
just introduced or moved. All nine were verified at source before being acted on;
one was judged pre-existing and is recorded rather than fixed.

- [x] **`agent_result` is a TERMINAL event, and the hook ignored it.** OpenCode's
      `runCompaction` and Codex's compact-spawn mode both settle through a
      synthetic `agent_result` and spawn no long-lived process, so `done` is
      never coming (`opencode/adapter.ts`, `codex-event-handler.ts`). Every
      OpenCode compaction therefore held the user's message for the full 300 s
      and was then reported as a timeout that had not happened. Settling on
      `agent_result` is safe for Claude and Grok too: both emit `agent_compacted`
      from a stream event that PRECEDES their result. The fake had to be fixed as
      well — it emitted a SUCCESSFUL result before an `error`, which no dying
      process does, and which made the error scripts unreachable through the
      settlement path two backends actually use.
- [x] **`verifyRunningState` honours the hold**, not just the periodic
      reconciler that calls it. `services/child-sessions.ts` calls it directly
      from `shipit session wait`, so a concurrent wait on a session inside its
      pre-turn phase cleared the agent slot and the delivery, emitted
      `turn_abandoned`, and reported the session idle before the user's turn ran.
- [x] **Both active-turn queue drains check the hold.** The interleaving: turn A
      clears `running` and awaits its local commit, message B is admitted and
      enters its pre-turn phase, A's commit finishes and its drain starts C
      alongside B. The turn-epoch guard cannot catch it — B does not bump the
      epoch until `executeAgentTurn`.
- [x] **A `/compact` arriving mid-phase is queued, not swallowed.** That branch
      returns unconditionally, so under the hold the command was spent either
      way: with an empty slot it evaporated, and once the compaction's proxy was
      installed it was fired at THAT process — a nested request against a spawn
      the user never made (req 12).
- [x] **Credential prep can arm a conversation replay AFTER the pre-gate** — the
      docs/153 leak repair does exactly that — and `buildRunParams` would then
      consume it. Re-checked after `prepareAgentEnv`; the operation stands down.
- [x] **The compaction stands down on an `unsettled` merge recheck**, as the
      reset already did. The session can read merged while the reset returns no
      prefix, so on Codex and OpenCode the turn would run with a summarized
      context and nothing saying the work shipped (req 7).
- [x] **The background-work skip now says so.** Every other `not-applicable`
      means the control was never offered or was unticked; this one happens with
      the box on screen and ticked, so silence was the req-9 failure shape in a
      case that is not, strictly, a failed compaction.
- [x] **An agent-factory throw no longer loses the compaction's notice too.** A
      container that will not hand back a proxy fails both calls, and the
      `finally` that delivers the notice sits far below the second one.
- [ ] **Not fixed, and pre-existing:** container `/agent/start` calls are
      serialized on `_startInFlight` with no timeout, so a start that never
      returns blocks the next one. docs/295 adds one more start per turn and so
      doubles the exposure, but the class predates it and belongs to
      `_startAgentViaProxy`, not here. Recorded rather than papered over.

**Guards for this round**, each proved red on its own: the `agent_result`
settlement (under fake timers, so a regression fails rather than taking five
minutes), the `unsettled` stand-down (through the REAL `recheckMergeBeforeTurn`,
driving the actual timeout race), the background-work notice, the late replay,
the dispatched drain, the WS drain, the mid-phase `/compact`, and
`verifyRunningState`. Two had to be rewritten after passing with their defect
present: the WS-drain test waited on `!running`, which is true for an instant
BEFORE the drain runs, and the `verifyRunningState` test used an unreachable
worker, whose catch returns the same value the guard does.

- [x] Full suite after this round: 999 files, 17,475 tests.

- [x] Comment the outcome on `planning#522`.
