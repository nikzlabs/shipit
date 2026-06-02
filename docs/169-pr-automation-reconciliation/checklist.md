# Checklist — PR automation reconciliation

## Decisions (resolved)
- [x] Toggle model → global + persisted, for both
- [x] Shared base → full generic base class
- [x] Auto-merge → leave manager, share attach-state helper only
- [ ] Finer call: arbiter release-on-push timing (instant vs confirm-new-head)
- [ ] Finer call: settings UI grouping ("PR automations" group)

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
- [ ] Move auto-fix toggle to global+persisted (`credentialStore` + settings), remove per-session card toggle
- [ ] Migration: default off, no surprise re-enables
- [ ] Align `attachAutomationState` shapes (incl. auto-merge via shared helper)

## Workstream C — cross-automation arbitration
- [ ] Add `auto-remediation-arbiter.ts` — per-session claim/release
- [ ] Suppress other automations while a claim is held
- [ ] Await-fresh-signal: suppress all until a new head SHA is observed after a push
- [ ] Stale-signal guard via `lastActedHeadSha`
- [ ] Auto-merge consults arbiter as a precondition
- [ ] Release on every terminal path (success/error/exhausted/deferred/timeout)
- [ ] Test: claim free after each terminal path (liveness)
- [ ] Test: full cycle — auto-resolve push → new head → CI fails → auto-fix may claim

## Verification
- [ ] Port existing auto-resolve + pr-ci-fix tests, refactor under green
- [ ] New unit tests for the shared base
- [ ] `npm run lint:dev` + `npm run typecheck` clean
- [ ] Update CLAUDE.md / shipit-docs if agent-facing behavior changed
