# Checklist — Pause CI auto-fixing per session

- [x] DB migration: `sessions.auto_fix_ci_paused` column
- [x] `SessionInfo.autoFixCiPaused` type + `SessionRow`/`fromRow` mapping
- [x] `SessionManager.setAutoFixCiPaused`
- [x] `isSessionEnabled` gate in `AutoRemediationManager` (runTransition + onRunnerIdle)
- [x] `AutoFixManager` forwards the per-session gate
- [x] Poller wires the gate to the session flag
- [x] `POST /api/sessions/:id/pr/auto-fix-pause` route (persist + re-broadcast)
- [x] `session-store.setAutoFixCiPaused` optimistic action
- [x] `AutoFixPauseToggle` component
- [x] Render in `PrActionsMenu`, gated on the global setting
- [x] Unit test: paused session does not fire; resume re-enables
- [x] Persistence test: flag round-trips across manager instances
- [x] Route test: persist/clear + 404/400 validation
- [x] Typecheck + lint clean
