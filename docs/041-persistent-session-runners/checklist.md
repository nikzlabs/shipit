# 041 — Persistent Session Runners: Remaining Work

## Integration tests

- [x] Create `multi-tab.test.ts` with dedicated multi-tab scenarios:
  - [x] Two connections viewing different sessions get isolated agents and previews
  - [x] Two connections viewing same session share agent events and preview
  - [x] Interrupt from one tab affects shared runner, both tabs notified
  - [x] Session switch in one tab doesn't affect the other tab's view
  - [x] `full_reset` from one tab notifies and resets all tabs
  - [x] File tree / git log requests scoped to each connection's viewed session
- [x] Add "multiple concurrent agents across sessions" integration test to `persistent-runner.test.ts`

## Per-session port tracking

- [x] Move `detectedPorts` from global variable in `index.ts` into `SessionRunner` so each session tracks its own detected ports independently
- [x] Send detected port results only to viewers of that session, not globally

## Phase 2: Terminal persistence

- [x] Move terminal from per-connection into `SessionRunner`
- [x] Buffer recent PTY output (rolling 10K characters) for reconnection replay
- [x] Terminal switch on session switch shows existing terminal with scrollback
