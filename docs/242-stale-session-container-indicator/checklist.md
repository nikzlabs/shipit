# Checklist

- [ ] Preserve the worker build ID on fresh and rediscovered `SessionContainer` records
- [ ] Centralize build-freshness classification and reuse it in adoption logging
- [ ] Add the session-scoped `session_container_freshness` WebSocket message
- [ ] Emit freshness on attachment and relevant container lifecycle changes
- [ ] Store/reset freshness in client session state and discard foreign-session messages
- [ ] Add the active-chat stale-container warning and agent-only restart action
- [ ] Reuse the existing restart overlay, reconnect, and error behavior
- [ ] Add server classification, discovery, and attachment tests
- [ ] Add client rendering, safety, restart-failure, and message-scoping tests
- [ ] Update docs/113 status/key-file notes when implementation lands
- [ ] Run affected tests, `npm run lint:dev`, and `npm run typecheck`
- [ ] Verify the warning in the live preview across themes and mobile/desktop layouts
