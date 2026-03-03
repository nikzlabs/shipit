# 065 — Terminal UI Fixes Checklist

## P0 — Correctness
- [ ] Debounce `ResizeObserver` callback in `InteractiveTerminal` (~150ms)
- [ ] Add tests verifying resize messages are debounced
- [ ] Send initial `cols`/`rows` as part of `terminal_start` message
- [ ] Update `WsTerminalStart` type to include optional `cols`/`rows`
- [ ] Update `handleTerminalStart` handler to forward dimensions
- [ ] Remove the `setTimeout(100)` for initial resize
- [ ] Add integration test for `terminal_start` with dimensions

## P1 — Robustness
- [ ] Keep shell tab mounted (hidden) to preserve xterm.js instance across tab switches
- [ ] Remove or repurpose `startedRef` guard
- [ ] Add component test for tab switching preserving terminal state
- [ ] Switch log auto-scroll from `smooth` to `instant` (or rate-adaptive)
- [ ] Add component test for auto-scroll behavior during rapid entry bursts

## P2 — Performance
- [ ] Add monotonic ID to `LogEntry` (assign in store on receipt)
- [ ] Use entry ID as React key instead of array index
- [ ] Evaluate virtualized list for logs (`@tanstack/react-virtual`)
- [ ] Implement virtualization if log volume warrants it
- [ ] Add performance test or benchmark for large log volumes
