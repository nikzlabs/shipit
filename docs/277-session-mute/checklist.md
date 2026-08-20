# Checklist — mute a session

- [x] `requirements.md` written from the human's words, open questions asked and answered
- [x] `plan.md` — storage, clearing point, and who may set the mute
- [x] Migration: `sessions.muted_at`
- [x] `SessionInfo.mutedAt` + `SessionRow.muted_at` + `SessionManager.setMuted()`
- [x] `setSessionMuted()` service with the agent-not-working gate (req 6)
- [x] `PUT /api/sessions/:id/muted`
- [x] Clear the mute at turn start in `executeAgentTurn`, broadcast only when it changed (req 4)
- [x] `muted` input to `computeAttentionReason` — one place, every surface (req 2)
- [x] `setMuted` store action, optimistic with rollback
- [x] Mute / Unmute menu item on the session row (reqs 1, 5, 6)
- [x] Tests: derivation, service gate, turn-start clear, row menu, "Needs you" membership
- [x] Independent review against every numbered requirement
