# Checklist — a command invocation reaches the harness alone

- [x] Measure the skill case on the pinned Claude Code binary (req 6)
- [x] `isCommandInvocation` in `shared/command-invocation.ts`, with its unit tests
- [x] Interactive turn: widen the predicate, drop `ridesTurnGoalCommand` and `opts.verbatim`
- [x] Dispatched turn: same decision, with the origin-wrapper exclusion
- [x] Steering: deliver a command invocation alone
- [x] Attachment refusal generalized to every command invocation, at the entry point
- [x] Delete `assembleAgentPrompt`'s slash branch and the tests that pinned it
- [x] Integration coverage: a pending notice, a role brief, and attachments, on a non-goal command
- [x] `npm run typecheck`, `npm run lint:dev`, `npm test`
- [x] Independent review, then one PR closing planning#530
