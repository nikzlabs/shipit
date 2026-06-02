# Checklist — PR automation reconciliation

## Decisions (resolved)
- [x] Toggle model → global + persisted, for both
- [x] Shared base → full generic base class
- [x] Auto-merge → leave manager, share attach-state helper only
- [x] Finer call: arbiter release-on-push timing — confirm-new-head (await-fresh-signal keys off the next observed head SHA, not the instant of push)
- [x] Finer call: settings UI grouping — both toggles live under a "PR automations" group

## Workstream A — unify agent-injection path
- [x] Add `postTurn: "commit-push" | "none"` to `AgentDispatchOptions`; thread through `dispatched-turn.ts` adapter
- [x] Gate `runCommitAndPr` / `scheduleAutoPush` / `tryDrain` in `turn-executor.ts` `executeAgentTurn` on `postTurn: "none"`
- [x] Add `systemTurn: true` dispatch option that sets/clears `systemTurnInProgress` (synchronous with `_isRunning` flip)
- [x] Add turn-completion signal (`onTurnComplete({ errored })` callback) to a dispatched turn
- [x] Rewrite `runRebaseResolutionTurn` on top of `dispatch({ systemTurn: true, postTurn: "none" })`; delete hand-rolled lifecycle (incl. its `systemTurnInProgress` management)
- [x] Audit CI-fix dispatch: now `systemTurn: true` (a user message mid-CI-fix is queued, not steered)
- [x] Port wall-clock timeout teardown to the shared path (timeout surfaces as an `error` outcome → writeBack → release)
- [x] Test: NO commit/push happens during a conflict-resolution turn (rebase-driver tests assert the rebase completes via `rebase --continue`, which an auto-commit would corrupt)
- [x] Test: a user `send_message` during a system turn is queued, NOT steered into it (dispatch-steering + systemTurnInProgress)

## Workstream B — unify state machine + toggle
- [x] Extract shared remediation base (`auto-remediation-manager.ts`): SHA-reset, cooldown gate, attach-state, `resetForUserActivity`, runner gate, `onRunnerIdle`
- [x] Reimplement `AutoFixManager` on the shared base (turn-mode accounting)
- [x] Reimplement `AutoConflictResolveManager` on the shared base (preserve race ordering — 22 tests green)
- [x] Add post-turn status re-arm for CI autofix (`completeTurn`) so the loop reaches attempts 2 & 3
- [x] Add cooldown to CI autofix (`AUTO_FIX_COOLDOWN_MS`), only meaningful after re-arm
- [x] Test: a still-red CI after a fix turn re-fires up to MAX attempts (not just once)
- [x] Wire `resetForUserActivity` for CI autofix in `index.ts` (via `resetRemediationForUserActivity` fan-out)
- [x] Move auto-fix toggle to global+persisted (`credentialStore.autoFixCi` + settings), remove per-session card toggle + route
- [x] Migration: default off, no surprise re-enables (old toggle was in-memory; nothing persisted to migrate)
- [x] Align `attachAutomationState` shapes (auto-fix drops per-session `enabled`, gains `deferred`)

## Workstream C — cross-automation arbitration
- [x] Add `auto-remediation-arbiter.ts` — per-session claim/release
- [x] Suppress other automations while a claim is held
- [x] Await-fresh-signal: suppress all until a new head SHA is observed after a push
- [x] Stale-signal guard via `lastActedHeadSha`
- [x] Auto-merge consults arbiter as a precondition (`isClaimed`)
- [x] Release on every terminal path (success/error/exhausted/deferred/timeout) — single release site in each manager's terminal writer
- [x] Test: claim free after each terminal path (liveness)
- [x] Test: full cycle — auto-resolve push → new head → CI fails → auto-fix may claim

## Verification
- [x] Port existing auto-resolve + pr-ci-fix + rebase-driver tests, refactor under green
- [x] New unit tests: shared base (via conflict + CI manager suites), arbiter, CI auto-fix manager
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] No agent-facing (shipit-docs) behavior changed — the toggles are user settings, not container behavior

## Notes / follow-ups
- CI fix releases the arbiter with `pushed: false` (it does not arm await-fresh-signal). The conflict automation's own UNKNOWN-mergeability gating covers the brief post-CI-push window; the conflict→CI direction (the one prone to acting on a stale `failure` verdict) is fully covered. Tightening CI→conflict suppression to key on the actual post-fix push is a possible follow-up.
