# Checklist — PR automation reconciliation

## Decisions (do first)
- [ ] Resolve Open question 1: toggle model (per-session+persisted vs global+persisted)
- [ ] Resolve Open question 2: full base class vs shared-helpers module
- [ ] Resolve Open question 3: auto-merge inclusion scope

## Workstream A — unify agent-injection path
- [ ] Add `postTurn: "commit-push" | "none"` to `AgentDispatchOptions` + `SystemTurnDeps`
- [ ] `dispatched-turn.ts` honors `postTurn: "none"` (skip commit/push/drain)
- [ ] Add turn-completion signal (Promise/callback) to a dispatched turn
- [ ] Rewrite `runRebaseResolutionTurn` on top of `dispatch()`; delete hand-rolled lifecycle
- [ ] Port wall-clock timeout teardown to the shared path
- [ ] Test: assert NO commit/push happens during a conflict-resolution turn (all exit paths)

## Workstream B — unify state machine + toggle
- [ ] Extract shared remediation base / helpers (SHA-reset, cooldown, attach-state, resetForUserActivity)
- [ ] Reimplement `AutoFixManager` on the shared base
- [ ] Reimplement `AutoConflictResolveManager` on the shared base (preserve race ordering)
- [ ] Add cooldown to CI autofix
- [ ] Wire `resetForUserActivity` for CI autofix in `index.ts`
- [ ] Make toggle model consistent across both (persistence + UI per decision 1)
- [ ] Align `attachAutomationState` shapes

## Verification
- [ ] Port existing auto-resolve + pr-ci-fix tests, refactor under green
- [ ] New unit tests for the shared base
- [ ] `npm run lint:dev` + `npm run typecheck` clean
- [ ] Update CLAUDE.md / shipit-docs if agent-facing behavior changed
