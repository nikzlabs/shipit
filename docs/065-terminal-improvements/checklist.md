# 065 — Terminal Improvements Checklist

## Part 1 — UI Component Fixes

### P0 — Correctness
- [x] Debounce `ResizeObserver` callback in `InteractiveTerminal` (~150ms)
- [x] Add tests verifying resize messages are debounced
- [x] Send initial `cols`/`rows` as part of `terminal_start` message
- [x] Update `WsTerminalStart` type to include optional `cols`/`rows`
- [x] Update `handleTerminalStart` handler to forward dimensions
- [x] Remove the `setTimeout(100)` for initial resize
- [x] Add integration test for `terminal_start` with dimensions

### P1 — Robustness
- [x] Keep shell tab mounted (hidden) to preserve xterm.js instance across tab switches
- [x] Remove or repurpose `startedRef` guard
- [x] Add component test for tab switching preserving terminal state
- [x] Switch log auto-scroll from `smooth` to `instant` (or rate-adaptive)
- [x] Add component test for auto-scroll behavior during rapid entry bursts

### P2 — Performance
- [x] Add monotonic ID to `LogEntry` (assign in store on receipt)
- [x] Use entry ID as React key instead of array index
- [x] Evaluate virtualized list for logs (`@tanstack/react-virtual`) — not warranted (500-entry client cap produces trivial DOM; adding a virtualization dependency would increase complexity without measurable benefit)
- [x] ~~Implement virtualization if log volume warrants it~~ — skipped per evaluation above

## Part 2 — Architecture Fixes

### P0 — Correctness
- [x] Add output rate tracking in session worker SSE broadcast
- [x] Implement PTY pause/resume when SSE buffer exceeds threshold
- [x] Add test for backpressure behavior under fast PTY output
- [ ] Evaluate persistent connection (WS or Unix socket) for orchestrator↔worker terminal I/O
- [ ] Implement persistent connection if latency measurements justify it
- [ ] Remove HTTP POST path for `terminal_input` once persistent connection is in place

### P1 — Robustness
- [ ] Detect SSE disconnection in `ContainerSessionRunner`
- [ ] Add reconnection with exponential backoff (3 retries)
- [ ] Send `terminal_reconnecting` status to client during recovery
- [ ] Add integration test for SSE disconnect → reconnect flow
- [ ] Prepend terminal reset sequence (`\x1bc`) to replayed buffer on reconnect
- [ ] Truncate output buffer at last complete line or reset sequence, not arbitrary byte
- [ ] Add test for buffer truncation producing valid terminal output
- [ ] Document relationship between server buffer (10KB) and client scrollback (1000 lines)
- [ ] Consider increasing server buffer to ~80KB to approximate client scrollback

### P2 — Future
- [ ] Design multi-terminal protocol (terminalId on all messages)
- [ ] Update `TerminalProcess` management to `Map<string, TerminalProcess>` in worker
- [ ] Update `ContainerSessionRunner` to track per-terminal output buffers
- [ ] Add client UI for multiple terminal tabs
