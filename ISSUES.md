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
