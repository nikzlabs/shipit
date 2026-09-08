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

### Fifth review round — a COLD review, and the ownership is still incomplete

Given the requirements and the diff with no mention of the earlier rounds and no
findings to confirm. It found five defects, four P1, three reproduced in memory
by the reviewer — and, more usefully, named the shape of the remaining problem:

> *"Incomplete ownership: the new hold governs selected admission checks, while
> cancellation, readiness, teardown, and transcript persistence still use
> different signals. Keeping compaction separate from the turn executor is
> reasonable, but the phase needs coherent ownership across those consumers. A
> compaction-specific persistence bypass cannot provide that."*

That is right, and it is the same shape as round 2's finding: the pre-turn phase
has been extended to one consumer family at a time, per review round, while the
others still read `running` or the turn accumulators. All five verified at source
before being recorded. **None are fixed.**

- [ ] **[P1] Any OTHER side-channel card written during the phase is deleted by
      the user's turn.** `emitChatCard` branches on `runner.running`, which is
      true throughout; the card lands in the PREVIOUS turn's accumulators, which
      `resetRunnerTurnState` then clears and `replaceInProgress` deletes. There
      are ~20 such call sites (bug reports, issue cards, sub-agent consult cards,
      session title, self-merge-watch, propose-actions, egress). Before docs/295
      this window was milliseconds; the compaction makes it minutes. **The
      direct-append fix protects the compaction card only** — the bypass the
      reviewer names. The real fix is that `emitChatCard` should branch on
      "is a turn ACCUMULATING", not on `running`.
- [ ] **[P1] The WS steer gate reads a STALE hold.** `send-message.ts:129`
      captures `heldByMerge` before `await verifyRunningState()`; the outer
      re-check at :149 correctly re-reads `preTurnHold`, but the steer gate at
      :213 still uses the captured value. A send whose verify round-trip overlaps
      another send entering its pre-turn phase is therefore steered into the
      resident process the compaction is about to retire and kill — delivered
      nowhere, with no queued copy. Exactly the defect fixed in
      `dispatchOnRunner`, missed on the WS path.
- [ ] **[P1] A predecessor's late `done` clears the pending turn's `running`.**
      `turn-executor.ts` documents this window as *"deliberately accepted"*
      because *"it is self-healing — the queued turn's own `executeAgentTurn`
      sets `running` again at entry"*. docs/295 invalidates that argument: it
      widens the window from a few awaits to a merge probe plus a 300 s
      compaction plus a branch reset, and nothing in the phase re-sets `running`.
      The session then reads idle for minutes — `shipit session wait` reports
      ready — and once the predecessor's post-turn lease ends nothing protects it
      from idle disposal. **This falsifies the reasoning for leaving `preTurnHold`
      out of `agentBusy` and `dispose()`**, which was "redundant with `running`".
- [ ] **[P1] The timeout cancels nothing in the worker.** `agent.run()` enqueues
      onto the container runner's serialized `_startInFlight` with an unbounded
      `/agent/start`; the hook's 300 s timer kills the proxy and returns, but the
      start stays pending and the user's spawn queues behind it. If it later
      resumes it can still start the abandoned compaction — the ownership check
      is before `run()`, not inside the proxy's async start. Round 4 recorded the
      serialization as pre-existing and out of scope; that was too generous, as
      the abandoned-start half is this feature's own.
- [ ] **[P2] A failed reset now removes the req-7 guarantee.** Compaction
      succeeds, the reset's `git fetch` throws → `NOT_MOVED`, empty prefix. On
      Codex and OpenCode, which ignore the compaction instructions, the turn then
      carries NO statement that the PR merged. Before this feature a failed reset
      was survivable because the agent's own context still held that knowledge;
      the compaction is what removes the fallback.

**Blind tests named by the review**, all confirmed: the req-7 test stubs the
reset so it cannot see a real `NOT_MOVED`; the integration test asserts only on
the compaction card, so it cannot see any other card being deleted; the timeout
tests defer credential prep or count a fake `kill()` and never exercise the
serialized worker start; and the drained-delivery test never delivers the
predecessor's late `done`.

### The rewrite — sequencing instead of nesting

Nik's observation ended five rounds of this: *"if I now do a compaction manually,
so I press compact, and then I send a turn, everything already works."* It does.
The whole cost of rounds 1–5 came from running the compaction NESTED inside the
user's send, and none of it came from the compaction. So ShipIt now does what the
user does by hand — queue the message, run a `/compact` turn, let the queue drain
— and the five open defects are gone because the state they lived in does not
exist.

- [x] **Deleted:** `pre-turn-compact-hook.ts` (the slot-owning operation, its
      settle latch, its 300 s timeout, its ownership re-checks, its credential
      teardown, its persistence bypass, its outcome/notice machinery),
      `pre-turn-hold.ts`, `missing-conversation.ts`,
      `SessionRunnerInterface.preTurnHold` and its six admission checks, the
      `mergeRecheck` hand-off through `preTurnReset`, and the ownership
      publication `runDispatchedTurn` needed to make a pre-turn phase legible.
      **The suite shrank**, which is the honest signal for a removal: 999 files /
      17,475 tests → 998 / 17,435, with more behaviour covered than before.
- [x] **Added:** `compact-before-turn.ts` (a decision, ~60 lines of logic), two
      four-line takeovers, and one new field — `silent`, which suppresses the
      user row and echo for a turn ShipIt started. That field is a value, not a
      mechanism: the executor already took both halves as inputs.
- [x] **Every one of the fifth round's five defects is answered by construction,
      not patched.** The card-deletion class (its P1 #1) cannot occur because no
      card is ever written outside a turn. The stale-hold steer (#2) and the
      predecessor's-late-`done` (#3) cannot occur because there is no hold and no
      phase. The uncancellable worker start (#4) is an ordinary turn's start. And
      #5 — a failed reset stripping the req-7 guarantee — is unchanged in kind
      but no longer specific to this feature: the reset runs on the user's turn
      exactly as docs/218 shipped it.
- [x] **Requirement 9 became structural.** No timeout, no fail-safe outcome, no
      notice: the message is in the queue before the compaction starts, and every
      terminal path of a turn drains it (CLAUDE.md post-turn invariant 2).
- [ ] **One deliberate trade, recorded rather than hidden:** a backend that
      accepts the trigger, exits 0 and compacts nothing now shows as a turn with
      no compaction card, where the nested design emitted a sentence saying so.
      The requirement is that a failure is never silent; an absent card beside a
      completed turn is not a claim of success. Revisit if it reads badly.

**Guards for the rewrite**

- [x] `compact-before-turn.test.ts` — 11 tests over the gates, including the
      `"unsettled"` race driven through the REAL `recheckMergeBeforeTurn`.
- [x] `dispatched-turn-compaction.test.ts` — 8 tests over the takeover through
      the real `SessionRunner.dispatch` → `runDispatchedTurn` path, with only the
      decision stubbed.
- [x] `integration_tests/pre-turn-compaction.test.ts` — **unchanged from the
      previous design and still passing.** It was written against the nested
      slot-owning operation and passes against sequencing, because it asserts on
      observable behaviour: two spawns in order, one user row, and a
      `GET /history` read after the user's turn finishes. That is the clearest
      evidence available that it tests the requirement rather than the mechanism.
- [x] Four mutations proved red: dropping the `systemTurn` inheritance (the
      compaction declines to start the message it made room for), dropping
      `compactContext: false` on the dispatched re-queue (the compaction loop),
      and dropping `silent` (a `/compact` bubble nobody typed).
- [x] **One mutation was BLIND and is recorded as such:** dropping
      `compactContext: false` on the *interactive* re-queue changes nothing,
      because the WS drain re-enters `runAgentWithMessage`, which holds no
      decision. That flag earns its keep on the `releaseQueuedTurn` path, which
      routes the same entry onto the dispatched executor — where the dispatched
      test's mutation does go red.
- [x] Two bugs in the rewrite were found by its own tests before review: the
      `systemTurn` inheritance above, and a stub that ignored `intent` and so
      could not have failed on the loop it existed to guard.
- [x] Full suite: 998 files, 17,435 tests. `npm run typecheck` and
      `npm run lint:dev` clean.

- [x] Comment the outcome on `planning#522`.
