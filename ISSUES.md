# Known Issues & Future Work

## Open

### 1. Message edit/retry: Claude retains full context after UI truncation

**Severity**: Low — cosmetic/UX mismatch, not a bug

When a user edits or retries a message, `handleEditMessage` in `App.tsx` truncates the UI messages array and sends the new text as a regular `send_message`. However, Claude's CLI session (via `--resume`) retains the full prior conversation history server-side.

This means after an edit:
- The **UI** shows: messages up to the edit point + new user message + new Claude response
- **Claude's context** includes: all original messages (including the ones removed from the UI) + the new user message

Claude may reference or build on information from messages the user can no longer see, which can be confusing.

**Current behavior**:
1. User sends message A, Claude responds with B
2. User edits message A to A' — message B is removed from UI
3. Claude receives A' but still has A and B in its context
4. Claude may say "as I mentioned earlier..." referencing content from B that is no longer visible

**Possible fixes** (all require significant work):
1. Start a new CLI session with a replayed conversation prefix (complex, may lose tool state)
2. CLI-level support for conversation truncation/branching (not currently available in Claude Code CLI)
3. A server-side conversation-replay mechanism that spawns a new session with the truncated history as system context

**Workaround**: The current behavior is acceptable and matches what ChatGPT does. Documented in `ARCHITECTURE.md` under "Message Editing & Retry".

**Files**: `src/client/App.tsx` (`handleEditMessage`), `src/client/components/MessageList.tsx` (`MessageEditor`)

### 2. Periodic port scanner: overlapping scans not guarded

**Severity**: Low — only a concern if `DEFAULT_SCAN_PORTS` grows significantly

The periodic scanner uses `setInterval` with no guard against overlapping scans. If a scan takes longer than the interval, a second scan starts before the first completes. Currently safe because each scan checks 9 ports concurrently with a 300ms TCP timeout, finishing well within the 5-second interval. But if `DEFAULT_SCAN_PORTS` grows or network conditions degrade (e.g., running inside a high-latency container), overlapping scans could cause redundant broadcasts or stale data races.

**Fix**: Add an `isScanning` boolean guard in `runPortScan()` to skip the scan if one is already in progress.

**Files**: `src/server/index.ts` (`runPortScan`, `startPortScanInterval`)

### 3. Preview status broadcasts not throttled

**Severity**: Low — unlikely in practice

If a port rapidly appears and disappears (e.g., a server restarting in a loop), every change triggers a `preview_status` broadcast to all connected clients. There is no debounce or throttle, so clients could receive a burst of status messages causing unnecessary re-renders and iframe reloads.

**Fix**: Add a debounce (e.g., 500ms) to `broadcastPreviewStatus()` so rapid changes are collapsed into a single broadcast.

**Files**: `src/server/index.ts` (`broadcastPreviewStatus`, `runPortScan`)
