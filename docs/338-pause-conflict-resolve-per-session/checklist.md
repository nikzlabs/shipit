# Checklist — Pause conflict auto-resolve per session

- [x] `sessions.auto_resolve_conflicts_paused` column, `SessionInfo` field, setter
- [x] Per-session gate in `AutoConflictResolveManager`, wired in the poller
- [x] Gates re-checked after the awaits in the shared remediation base
- [x] `POST /api/sessions/:id/pr/auto-resolve-pause`
- [x] Store action, `AutoResolvePauseToggle`, PR ⋮ menu entry
- [x] Failure banner hidden while paused; attention marker reads both pauses
- [x] Tests, typecheck, lint
- [x] Wiki and docs/186 updated
