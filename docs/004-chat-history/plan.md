---
status: in-progress
---
# Chat History

Messages are persisted to disk per session so conversations survive page reloads, browser restarts, and session switching.

## Storage

- **Location**: `/workspace/.vibe-chat-history/{sessionId}.json`
- **Format**: JSON array of `PersistedMessage` objects (same as `ChatMessage` minus `streaming` field)
- **Session ID sanitization**: Non-alphanumeric characters (except `-` and `_`) replaced with `_` to prevent path traversal

## How messages are saved

- **User messages**: Saved when `send_message` is received. For new sessions (no `sessionId`), saved once `system.init` provides the session ID. For resumed sessions, saved immediately.
- **Assistant messages**: Final text and tool use blocks accumulated during streaming, saved when `result` event fires.
- **Error messages**: CLI crashes and process errors saved with `isError: true`.

## How messages are loaded

Client requests history via `{ type: "get_chat_history", sessionId }`. This happens:
- **On page reload**: Client stores current session ID in `localStorage` (key: `vibe-current-session`). On WebSocket connect, requests that session's history.
- **On session resume**: When user resumes a session via `SessionSelector`.

## Tool results

Tool results (`tool_result` blocks from `user` events) are parsed in `App.tsx` and attached to the preceding assistant message as `toolResults: ToolResultBlock[]`. Results are matched by `tool_use_id`. Tool results are NOT persisted to chat history — they can be very large and are ephemeral.

## Key files

- `src/server/chat-history.ts` — `ChatHistoryManager` class: append, load, delete, listSessions
- `src/server/index.ts` — Wires ChatHistoryManager in WebSocket handler
- `src/client/App.tsx` — Client-side history request on connect/resume, `chat_history` handler
