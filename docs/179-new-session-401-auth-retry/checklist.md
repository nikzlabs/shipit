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
- [x] typecheck + lint clean
- [x] Feature doc (this folder)
