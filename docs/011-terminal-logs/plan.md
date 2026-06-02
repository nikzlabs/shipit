# Terminal / Logs Panel

The Terminal tab shows Claude CLI output (stderr, non-JSON stdout) in a terminal-like pane for debugging.

## Log sources

| Source | Meaning | Label | Color |
|--------|---------|-------|-------|
| `stderr` | Claude CLI stderr output | `[err]` | Red |
| `stdout` | Non-JSON stdout lines | `[out]` | Gray |
| `server` | Server lifecycle events (process start/exit/error) | `[srv]` | Blue |
| `preview` | Errors from preview iframe | `[pre]` | Orange |
| `deploy` | Deployment build/deploy output | `[dpl]` | Cyan |

## Data flow

1. `ClaudeProcess` emits `"log"` events for stderr and non-JSON stdout
2. `index.ts` listens for `"log"` events, calls `broadcastLog()` → wraps in `WsLogEntry` with timestamp
3. Server maintains circular buffer of 500 most recent entries
4. New clients receive entire buffer on connect
5. `clear_logs` client message empties the buffer

## UI features

- Timestamp (HH:MM:SS), color-coded source label, log text with `whitespace-pre-wrap`
- Source filter: toggleable buttons per source type (at least one must remain active)
- Auto-scroll to bottom (disabled when user scrolls up)
- Clear button resets both client state and server buffer
- Unread badge when Terminal tab is not active

## Key files

- `src/server/claude.ts` — Emits `"log"` events
- `src/server/types.ts` — `WsLogEntry`, `WsClearLogs` message types
- `src/server/index.ts` — `broadcastLog()`, circular buffer, `clear_logs` handler
- `src/client/components/TerminalPanel.tsx` — Terminal UI, auto-scroll, source filters
- `src/client/App.tsx` — `logEntries` state, `log_entry` handler, unread badge
