---
status: planned
---

# 065 — Terminal Improvements

Fixes and improvements across the full terminal stack — UI components, orchestrator-worker communication, and PTY management. Issues are ordered by impact within each section.

## Key files

- `src/client/components/InteractiveTerminal.tsx`
- `src/client/components/TerminalPanel.tsx`
- `src/server/orchestrator/ws-handlers/terminal-handlers.ts`
- `src/server/orchestrator/container-session-runner.ts`
- `src/server/session/terminal.ts`
- `src/server/session/session-worker.ts`

---

## Part 1 — UI Component Fixes

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

**Fix:** Replace the plain `map()` with a windowed/virtualized list (`@tanstack/react-virtual` or similar). Only render entries visible in the viewport plus a small overscan buffer. Lower priority because typical sessions don't produce enough logs to matter, but it's the right long-term fix.

---

## Part 2 — Architecture Fixes

### P0 — Correctness

#### 7. Add flow control / backpressure for terminal output

**Problem:** If the PTY produces output faster than the browser can consume it (e.g., `cat /dev/urandom`, runaway build logs), there is no backpressure anywhere in the pipeline. The SSE stream from worker to orchestrator buffers unboundedly, the WS pipe from orchestrator to browser buffers unboundedly, and xterm.js will eventually choke. This can cause memory pressure on both the orchestrator and browser.

**Fix:** Add output rate limiting at the worker level. When the SSE event queue exceeds a threshold (e.g., 64KB pending), pause reading from the PTY (`pty.pause()` via node-pty). Resume when the buffer drains. On the client side, xterm.js handles large writes reasonably well, but the WS handler should drop or coalesce output chunks if the send buffer backs up.

#### 8. Replace HTTP-per-keystroke with a persistent connection for terminal input

**Problem:** Every `terminal_input` event goes from the orchestrator to the worker as a separate HTTP POST. That's a new TCP request per keypress (or small batch). Over localhost in Docker this is fast enough today, but it adds unnecessary overhead — connection setup, header parsing, response serialization — for what is fundamentally a stream of bytes.

**Fix:** Use the existing SSE connection bidirectionally (upgrade to WebSocket between orchestrator and worker), or open a dedicated Unix socket / named pipe for terminal I/O between the orchestrator and worker. This would let input and output flow over a single persistent connection, reducing latency and overhead. This is a larger change and may not be justified until latency is measurable, but it's the architecturally correct direction.

### P1 — Robustness

#### 9. Auto-recover terminal on worker crash / SSE disconnect

**Problem:** If the session worker crashes or the SSE connection between orchestrator and worker drops, the client receives a `terminal_exit` event and the terminal goes dead. The user must manually restart the shell. There is no automatic reconnection or recovery.

**Fix:** In `ContainerSessionRunner`, detect SSE disconnection and attempt to reconnect with exponential backoff (up to ~3 retries). If the worker process itself died, the container health check should restart it, after which the orchestrator can re-establish the SSE stream and send a new `terminal_start`. Notify the client with a `terminal_reconnecting` status message so they know recovery is in progress.

#### 10. Improve output buffer truncation handling

**Problem:** The 10KB output buffer in `ContainerSessionRunner` is a simple string that gets truncated from the front. A reconnecting client may receive output that starts mid-escape-sequence (e.g., a half-written ANSI color code), which corrupts xterm.js rendering until the next full reset sequence arrives.

**Fix:** When truncating the buffer, scan backward from the cut point to find the last complete line or the last ESC reset sequence (`\x1b[0m` or `\x1b[?1049l`). Truncate there instead of at an arbitrary byte boundary. Alternatively, prepend a terminal reset sequence (`\x1bc`) to the replayed buffer so xterm.js starts from a known-good state.

#### 11. Reconcile double buffering (server vs client)

**Problem:** Terminal output is buffered in two places: 10KB on the `ContainerSessionRunner` (byte-limited) and 1000-line scrollback in xterm.js (line-limited). These serve different purposes (server-side replay vs. client-side scroll) but can drift — the server may hold data that doesn't fit in client scrollback, or vice versa.

**Fix:** This isn't a bug, but the two buffers should be sized consistently. Either increase the server buffer to approximate 1000 lines of typical terminal output (~80KB), or accept the mismatch and document that server-side replay is a "best effort" snapshot. The key improvement is ensuring the replayed data doesn't corrupt the terminal (see fix #10).

### P2 — Future

#### 12. Support multiple terminals per session

**Problem:** Each session has exactly one `TerminalProcess`. Users who want to run a build in one shell and poke around in another cannot. This is a product decision, but the current architecture (single `terminal` field on the worker, single output buffer on the runner) would need rework.

**Fix:** Index terminals by ID. The worker manages a `Map<string, TerminalProcess>`, and all terminal messages (`start`, `input`, `resize`, `output`, `exit`) include a `terminalId` field. The client renders tabs or a split view. This is a significant feature, not a bugfix — include here for completeness but implement only if user demand warrants it.
