# Checklist — new-session 401 auth retry (docs/179)

- [x] `ClaudeOAuthRefresher.ensureFresh` — single-flight pre-read heal (healthy = no spawn)
- [x] Pre-spawn heal in `prepareSessionAgentEnvironment` (Step 2a), time-bounded + fail-open
- [x] Pre-naming heal in `graduateSession` / `scheduleSessionNaming`
- [x] Runtime-401 auto-retry in `turn-executor` (`willRecoverAuth` / `recoverAuth`, `isAuthRetry`, `persistGuard`)
- [x] `auth_required` listener split: quiet recovery vs. `surfaceReauth`
- [x] `ensureAgentTokenFresh` hook in `buildApp`, keyed by agent (claude → refresher, codex → no-op)
- [x] Plumb the healer through AppCtx / ApiDeps / RunnerRegistryDeps / SystemTurnDeps / graduate / env-prep
- [x] Unit tests: `ensureFresh` (5 cases)
- [x] Unit tests: `auth_required` handler recovery (3 cases)
- [x] Integration test: end-to-end 401 → heal → re-dispatch (+ fallback + bounded)
- [x] Runtime rejected-resume recovery: guarded pointer clear + one fresh-conversation retry
- [x] Finalize visible first-attempt output before auth or stale-resume retry resets
- [x] typecheck + lint clean
- [x] Feature doc (this folder)

## 2026-08-02 incident (session `bf04d140`) — silent double 401

- [x] `ensureFresh(accountId, { force: true })` — validity probe (tier 2) on the runtime-401 path, replacing the expiry short-circuit that made every heal a no-op
- [x] Forced probe classifies `revoked` / `missing_credentials` as **not** healed, so the card surfaces instead of burning the recovery budget
- [x] Forced probe on a live token returns `noop` without bumping `failureCount` (no schedule backoff from a session 401)
- [x] Proactive env-prep sweep (Step 2a) left unforced — cheap short-circuit preserved
- [x] `repushSessionAgentToken` — unconditional source→session token push before the healed retry, bypassing the `srcExp <= dstExp` guard; route-aware (docs/150 account root vs shared root vs `claude-env-oauth` no-op)
- [x] Persist the `auth_required` notice via `emitChatCard` + `finalizeInProgress` (survives detached viewer / switch / reload)
- [x] Persist the stale-resume notice ("Couldn't resume the previous conversation…")
- [x] Persist the no-result / empty-retry error, and suppress it on the auth path (the listener already owns that row)
- [x] Regression test: session token with a **later** `expiresAt` than the source but dead
- [x] Regression tests: forced-heal semantics, repush ordering, notice durability via `GET /history`
- [x] `syncAgentTokenBack` and its call sites deliberately untouched (sibling session owns write-back timing)
