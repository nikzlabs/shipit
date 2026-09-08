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

- [x] `ws-handlers/send-message.ts` — queue the message with
      `compactContext: false`, run the `/compact` turn `silent`.
- [x] `dispatched-turn.ts` — the same, before attachment resolution, inheriting
      `systemTurn`, excluding `postTurn: "none"`; wired through
      `SystemTurnDeps.shouldCompactBeforeTurn` in `runner-registry-factory.ts`.
- [x] `silent` on the dispatch and queue shape: no user row, no echo, on both
      transports.
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
- [x] Checked by default, re-ticked on send and on a session switch (req 2,
      req 5); rendered as a subordinate line in the existing control block.
- [x] The Settings → Advanced description names both actions (req 11).

## Tests

- [x] `compact-before-turn.test.ts` — every gate, including the `unsettled` race
      through the real `recheckMergeBeforeTurn`.
- [x] `dispatched-turn-compaction.test.ts` — the dispatched takeover through the
      real `SessionRunner.dispatch` path: order, once only, settlement from the
      drained turn, the `postTurn: "none"` and queued-`/compact` exclusions.
- [x] `integration_tests/pre-turn-compaction.test.ts` — a real merged
      repository end to end: two spawns in order, the compaction card and
      exactly one user row survive the user's turn; the untick and typed
      `/compact` cases.
- [x] `MessageInput.test.tsx`, `send-handler.test.ts` — the control, its
      re-tick rules, the payload flag, and the `/review` frame.

## Close-out

- [x] Independent review against every numbered requirement.
- [x] `plan.md` describes the shipped shape; issue planning#522 updated.
