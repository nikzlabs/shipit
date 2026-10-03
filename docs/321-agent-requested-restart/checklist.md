# 321 — Agent-requested container restart: checklist

- [x] `shipit session restart --note` in the shim, with help text and shim tests
- [x] Worker relay in `agent-ops-routes.ts`, with a relay test
- [x] `POST /api/sessions/:id/restart-after-turn` (`containerAccessible`, 503 without a container manager), added to the route-guard golden list
- [x] `sessions.pending_restart_note` column, migration and `SessionManager` accessors; a later call replaces the note
- [x] The step at the end of `runCommitAndPr`: current runner and current turn only; waits while a turn runs or a flow holds the session
- [x] Hold new messages with `systemTurnInProgress`; `restartAgent` option `carryQueue`; carried messages run after the wake turn
- [x] `restartAgent` + `wakeSessionWithTurn` with `prompts/post-restart-followup.md`
- [x] Failure (throw, missing container, or a wake that settles undelivered) parks the note with `appendPendingAgentNotice`
- [x] Integration test: request → turn ends → agent container restarted → the note comes back as a turn
- [x] Integration test: a message sent during the restart is kept and runs after the wake turn
- [x] Test: a late terminal callback from an older turn does not restart
- [x] shipit-docs `sessions.md`, `environment.md`, wiki `sessions.md`
