# 041 — Persistent Session Runners: Remaining Work

## Integration tests

- [ ] Create `multi-tab.test.ts` with dedicated multi-tab scenarios:
  - [ ] Two connections viewing different sessions get isolated agents and previews
  - [ ] Two connections viewing same session share agent events and preview
  - [ ] Interrupt from one tab affects shared runner, both tabs notified
  - [ ] Session switch in one tab doesn't affect the other tab's view
  - [ ] `full_reset` from one tab notifies and resets all tabs
  - [ ] File tree / git log requests scoped to each connection's viewed session
- [ ] Add "multiple concurrent agents across sessions" integration test to `persistent-runner.test.ts`

## Per-session port tracking

- [ ] Move `detectedPorts` from global variable in `index.ts` into `SessionRunner` so each session tracks its own detected ports independently
- [ ] Send detected port results only to viewers of that session, not globally

## Phase 2: Terminal persistence

- [ ] Move terminal from per-connection into `SessionRunner`
- [ ] Buffer recent PTY output (rolling 10K characters) for reconnection replay
- [ ] Terminal switch on session switch shows existing terminal with scrollback
