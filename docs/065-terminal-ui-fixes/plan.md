---
status: planned
---

# 065 — Terminal UI Fixes

Targeted fixes for the `InteractiveTerminal` and `TerminalPanel` components. Issues are ordered by impact — the first two affect correctness under real-world conditions, the rest are robustness and performance improvements.

## Key files

- `src/client/components/InteractiveTerminal.tsx`
- `src/client/components/TerminalPanel.tsx`
- `src/server/orchestrator/ws-handlers/terminal-handlers.ts`

## Prioritized fixes

### P0 — Correctness

#### 1. Debounce ResizeObserver resize events

**Problem:** The `ResizeObserver` callback calls `fitAddon.fit()` and sends a `terminal_resize` WS message on every pixel change. Dragging a panel divider fires dozens of resize messages per second, each triggering an HTTP POST to the worker and a `pty.resize()` call. Most intermediate sizes are immediately discarded.

**Fix:** Debounce the `ResizeObserver` callback by ~150ms. Only call `fitAddon.fit()` and `onResize()` once the user stops dragging. Use a `setTimeout`/`clearTimeout` pattern inside the observer callback — no new dependencies needed.

#### 2. Remove the 100ms setTimeout for initial resize

**Problem:** After calling `onStart()`, the component waits 100ms then sends the terminal dimensions. This is a race: the server may not have started the PTY yet (resize arrives too early), or may have started it well within 100ms (wasted latency). The server already accepts `cols`/`rows` as part of `terminal_start`.

**Fix:** Send initial dimensions as part of the `terminal_start` message instead of as a separate delayed resize. Update the `terminal_start` WS message type to include optional `cols`/`rows` fields, and pass them from `onStart()`. Remove the `setTimeout` entirely.

### P1 — Robustness

#### 3. Fix startedRef not surviving remounts

**Problem:** `startedRef` is a component-local ref. If `InteractiveTerminal` unmounts and remounts (e.g., user switches away from Shell tab and back), the ref resets to `false` and `onStart` fires again. The server handles this gracefully (replays buffered output), but the component creates a new xterm.js instance each time, losing client-side scrollback.

**Fix:** Lift the "started" state to the parent so the shell tab content stays mounted (hidden via CSS) once started, rather than unmounting/remounting. Alternatively, accept the remount behavior but remove the misleading `startedRef` guard — if remounting is intentional, the guard adds confusion without value.

#### 4. Use instant scroll during rapid log bursts

**Problem:** `scrollIntoView({ behavior: "smooth" })` is called on every new log entry. During rapid bursts (build output, install logs), smooth scroll animations queue up and fight each other, causing jittery/laggy scrolling.

**Fix:** Track the arrival rate of entries. If multiple entries arrive within a short window (~200ms), use `scrollTop` assignment or `behavior: "instant"` instead of smooth scrolling. Alternatively, always use instant scroll — smooth scrolling in a log viewer is cosmetic, not functional.

### P2 — Performance

#### 5. Add stable keys to log entries

**Problem:** Log entries are keyed by array index (`key={i}`). When entries are filtered by source, every entry after the first hidden one gets a new key, causing unnecessary re-renders.

**Fix:** Assign a monotonically increasing ID to each `LogEntry` when it's created (in the store or when received from the server). Use that ID as the React key.

#### 6. Virtualize the log list

**Problem:** The logs view renders every entry as a DOM node. For long-running sessions with thousands of log lines, this degrades scroll performance and increases memory usage.

**Fix:** Replace the plain `map()` with a windowed/virtualized list (`@tanstack/react-virtual` or similar). Only render entries visible in the viewport plus a small overscan buffer. This is lower priority because typical sessions don't produce enough logs to matter, but it's the right long-term fix.
