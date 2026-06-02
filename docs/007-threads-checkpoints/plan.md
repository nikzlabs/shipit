# Rollback System

Replaced the old threads/checkpoints system with a simpler rollback UX. Each assistant message that created a git auto-commit gets a rollback dropdown with three options.

## Options

1. **Rollback code** — `git reset --hard <parentCommit>`. Chat stays as-is. A visual divider + system note injected so Claude knows code was rolled back.
2. **Rollback code + chat** — Same git reset. Old messages stay visible but dimmed/read-only above a divider. Fresh CLI session with conversation replay in system prompt.
3. **Fork as new session** — New session (worktree) at that commit, with truncated chat history and conversation replay for Claude.

## How it works

### Commit linking

After each auto-commit, the server captures the parent commit hash (HEAD before commit) and the new commit hash. These are linked to the last assistant message via a `commit_linked` WS event and persisted in chat history.

### Rollback code

1. Server runs `git reset --hard <parentCommitHash>`
2. Refreshes file tree and git log
3. Sends `rollback_complete` with `mode: "code"`
4. Client inserts a divider message: "Code rolled back to \<hash\>"
5. A system note is prepended to the next message sent to Claude

### Rollback code + chat

1. Server runs `git reset --hard <parentCommitHash>`
2. Builds conversation replay from chat history up to the rollback point
3. Stores replay on session, clears agent session ID (forces fresh CLI session)
4. Sends `rollback_complete` with `mode: "code_and_chat"`
5. Client marks messages after rollback point as `rolledBack: true` (dimmed/read-only)
6. Next CLI session receives the conversation replay as system prompt

### Fork as new session

1. Truncates chat history to the rollback point
2. Creates new session via `forkSession()` with `startPoint: parentCommitHash`
3. Saves truncated history and conversation replay to the new session
4. Sends `session_forked` with new session info
5. Client shows notification in current chat

## Key files

- `src/server/orchestrator/ws-handlers/rollback-handlers.ts` — Three server-side handlers
- `src/server/orchestrator/services/replay.ts` — `buildConversationReplay()` utility
- `src/server/orchestrator/sessions.ts` — Replay storage/consumption on SessionManager
- `src/server/shared/types/ws-server-messages.ts` — `WsCommitLinked`, `WsRollbackComplete`, `WsSessionForked`
- `src/server/shared/types/ws-client-messages.ts` — `WsRollbackCode`, `WsRollbackCodeAndChat`, `WsForkSessionFromMessage`
- `src/client/components/RollbackDropdown.tsx` — Dropdown UI component
- `src/client/components/MessageList.tsx` — Renders rollback button on qualifying messages
- `src/client/hooks/useMessageHandler.ts` — Handles `commit_linked`, `rollback_complete`, `session_forked`

## Edge cases

- **During streaming**: Rollback button disabled while any message is streaming
- **Multiple rollbacks**: Each message tracks its own `parentCommitHash`, so sequential rollbacks work correctly
- **Chat history safety**: `.vibe-chat-history/` must be in `.gitignore` so `git reset --hard` doesn't clobber it
- **Stale context after code rollback**: System note injected into Claude's next prompt so it knows code was reverted
