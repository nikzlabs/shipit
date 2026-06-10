# Issue read navigation card — checklist

- [x] `IssueRefCard` type + `WsIssueRefCard` WS message (+ union)
- [x] Persist `issueRef` on chat history (column, migration, toRow/fromRow)
- [x] Emit the card from the `issue/view` route (best-effort, per-turn dedup)
- [x] Client: `IssueRefCard` component, live-append handler, MessageList render
- [x] Agent-facing note in `shipit-docs/issues.md`
- [x] Tests: history round-trip, integration emit + dedup, handler idempotency, component render
- [x] Typecheck + lint clean
