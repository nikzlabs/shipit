# 295 — Implementation checklist

Design: [plan.md](./plan.md). Requirements: [requirements.md](./requirements.md).

## The decision

- [x] `orchestrator/compact-before-turn.ts` — `shouldCompactBeforeTurn`, gated on
      the per-send untick, the shared setting, the harness capability, an armed
      conversation replay, resident background work, the docs/282 `unsettled`
      recheck and `isResetEligible`. Fail-safe false (req 9).
- [x] The post-merge `/compact` prompt with its instructions; Claude and Grok
      honour them, Codex and OpenCode ignore them (docs/276).

## The two takeovers (req 13)

- [x] `ws-handlers/send-message.ts` and the WS queue drain — put the message at
      the front of the queue with `compactContext: false`, run the `/compact`
      turn `silent` and as a system turn (`runCompactionAhead`).
- [x] `dispatched-turn.ts` — the same, before attachment resolution, excluding
      `postTurn: "none"`; wired through `SystemTurnDeps.shouldCompactBeforeTurn`
      in `runner-registry-factory.ts`.
- [x] A stop during the compaction still runs the message; a compaction turn
      with no card leaves a `warn` notice (req 9).
- [x] A dispatch's `turn_result` latch ignores the compaction's result.
- [x] `runDispatchedTurn` reserves the runner at entry; `systemTurnInProgress`
      describes the current turn (assigned at every start, cleared only while
      current).
- [x] The takeovers queue the raw send, so an upload reaches the agent once.
- [x] `silent` on the dispatch shape: no user row, no echo, on both transports.
- [x] The reset runs on the user's turn, after the compaction, so its merge
      prefix cannot be summarised away (req 7).

## The per-send intent (req 5, req 6)

- [x] `compactContext?: boolean` on `WsSendMessage`, non-sticky.
- [x] `compactContext` and `resetMergedBranch` ride the queue and the `/review`
      frame, so an untick survives a busy runner.
- [x] A `/compact` that queued is re-derived as the command on both drains
      (req 12): no reset, no prefixes, the adapter's compaction flag.

## Composer and setting

- [x] `showCompactControl = showResetControl && supportsCompaction` in
      `MessageInput.tsx`; no occupancy state (req 3, req 10).
- [x] Checked by default, re-ticked on send, keyed by session (req 2, req 5);
      rendered as a subordinate line in the existing control block.
- [x] The Settings → Advanced description names both actions (req 11).

## The untick survives until its message is sent (req 5)

- [x] The tick state is `mergeContinueOptOutBySession` in the PR store, mirrored
      to localStorage per session, and nothing keys on the control's visibility
      transition — so an eligibility answer arriving between the untick and the
      send cannot re-tick it, and neither can a remount.
- [x] The payload carries the intent when the control is shown **or** an opt-out
      is outstanding: an omitted field means "follow the setting", so the
      previous rule discarded the untick in the compacting direction.
- [x] `handleSendMessage` activates with `skipResetEligibleSignal`, so a send no
      longer echoes a pre-turn eligibility answer that cancels the composer's
      optimistic hide.
- [x] The sibling `resetMergedBranch` control takes the same fix.
- [x] **Every** `send_message` producer carries the intent, from the single
      `mergeContinueFrameFields` builder — the five `App.tsx` frames (action
      card, both release-card buttons, review comments, ask-for-review) sent
      neither flag, which is what made a card click ignore the checkbox.
- [x] Reading the intent and SPENDING it are one act: `sendUserTurn` consumes on
      a send that reached the wire, and only then (req 5). A builder alone let
      the action-card path carry an untick and never clear it.
- [x] `send-user-turn.ts` is the only file that builds a `send_message` frame; a
      guard fails the build on any other. A non-turn frame calls
      `sendControlFrame`, a named export rather than a comment.
- [x] The HTTP dispatch path (`POST /agent/dispatch`) carries and spends it for
      the four ShipIt buttons that use it; a CI auto-fix and an agent-interface
      continuation keep req 13.
- [x] Display and wire read one snapshot — a `storage` listener syncs another
      tab's write into the store.

## Tests

- [x] `compact-before-turn.test.ts` — every gate, including the `unsettled` race
      through the real `recheckMergeBeforeTurn`.
- [x] `dispatched-turn-compaction.test.ts` — the dispatched takeover through the
      real `SessionRunner.dispatch` path: order, once only, settlement from the
      drained turn, the `postTurn: "none"` and queued-`/compact` exclusions.
- [x] `integration_tests/pre-turn-compaction.test.ts` — a real merged
      repository end to end: two spawns in order, the compaction card and
      exactly one user row survive the user's turn; a queued send; a second
      send during the decision; stop; a missing card; the untick and typed
      `/compact` cases.
- [x] `MessageInput.test.tsx`, `send-handler.test.ts` — the control, its
      re-tick rules, the payload flag, and the `/review` frame.

## Close-out

- [x] Independent review against every numbered requirement.
- [x] `plan.md` describes the shipped shape; issue planning#522 updated.
