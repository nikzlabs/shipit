# 023 — Session Sharing: Remaining Work

Nothing has been implemented yet. No `session-export.ts`, no HTTP export endpoint, no export WS types, no client UI.

## Remaining

- [ ] Create `src/server/session-export.ts` with `exportSession()` — HTML snapshot and JSON bundle formats, secret redaction (`sk-`, `ghp_`, `Bearer ` patterns)
- [ ] Create `src/server/session-export.test.ts` unit tests (HTML export, JSON export, secret redaction, empty session, tool use rendering, large session)
- [ ] Add `GET /api/export/:sessionId` HTTP route in `src/server/index.ts` with `Content-Disposition` download header
- [ ] Add export options (HTML / JSON) to session context menu in `src/client/components/SessionSelector.tsx`; trigger browser download via anchor click
- [ ] Create `src/server/integration_tests/session-sharing.test.ts` (HTTP endpoint, unknown session 404, JSON format, Content-Disposition header)
