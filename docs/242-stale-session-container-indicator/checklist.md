# Checklist

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
