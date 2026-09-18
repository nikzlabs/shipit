# Checklist

- [x] Automatically recreate stale agent containers whose agent process is stopped after an orchestrator update
- [x] Reclaim (destroy, never recreate) every stale **idle** agent container at boot, keyed on `turnActive` rather than `running` — reqs 7, 8
- [x] Publish the docs/235 liveness axis on `/agent/status` (`backgroundTaskCount`, `selfWakeActive`) so the boot sweep cannot destroy live background work
- [x] Preserve the reservation / standby / busy-runner / probe-failure guards, and the docs/240 adopt path
- [x] Correct the update behaviour described in `deploy.sh`, the session-containers skill, the agent system prompt, and `/shipit-docs/environment.md`

- [x] Preserve the worker build ID on fresh and rediscovered `SessionContainer` records
- [x] Centralize build-freshness classification and reuse it in adoption logging
- [x] Add the session-scoped `session_container_freshness` WebSocket message
- [x] Emit freshness on attachment and relevant container lifecycle changes
- [x] Store/reset freshness in client session state and discard foreign-session messages
- [x] Add the active-chat stale-container warning and agent-only restart action
- [x] Reuse the existing restart overlay, reconnect, and error behavior
- [x] Add server classification, discovery, and attachment tests
- [x] Add client rendering, safety, restart-failure, and message-scoping tests
- [x] Update docs/113 status/key-file notes when implementation lands
- [x] Run affected tests, `npm run lint:dev`, and `npm run typecheck`
- [x] Verify the warning in the live preview across themes and mobile/desktop layouts
