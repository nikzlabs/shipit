---
issue: planning#610
description: Rollback and fork, the conversation replay that starts a fork's conversation, and why ShipIt never resets a stored one.
---

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

### The CLI owns its conversations

The rule (from the owner, 2026-10-15, after a production incident): **ShipIt never
re-sends the conversation to the agent CLI on its own, and never clears or replaces the
stored agent session id.** It passes the stored id to `--resume` and nothing else. The
only id it writes is the one the CLI reports in its own events (`agent-listeners.ts`,
init and result), and only once that conversation answered: at the model's first output
(not text the CLI or its adapter wrote itself, which the adapters mark `synthetic`) or at a
successful result. An unanswered failure (a refusal, a Stop) may store an id only for a
session's first conversation — no stored id and no replay waiting — so it never replaces a
stored id, and a refused fork attempt never retires the fork's replay. A harness cannot
change within a session, so no agent switch justifies a reset either.

The incident: a ~4,800-message Claude session lost its context after a Stop. The next
spawn ran the docs/153 credential repair, which judged the live conversation file "not
resumable" (it read the whole file into one string to inspect 50 lines, and a file past
V8's string limit threw), cleared the stored id and armed a replay of the whole chat into
the system prompt. The session worker refused that spawn request with 413 (its 1 MiB body
limit), and the replay had already been taken, so the following turn started an empty
conversation. `claude --resume` was never tried.

So these automatic paths are gone:

- the credential repair's id verdicts (`token-sync-manager.ts`): the Claude "no resumable
  jsonl" clear, the "recovered" id from the newest file on disk, and the Codex "no rollout
  on disk" clear. The repair is layout only now and reads no conversation file;
- the env-prep replay arming that followed them (`session-agent-env.ts`);
- `recoverMissingConversation` and `reseedConversationForRetry` (`turn-executor.ts`).

**When the CLI cannot resume** (`No conversation found with session ID` on stderr — matched
on a short rolling window, since pipe chunks can split the line), `agent-listeners.ts`
keeps the stored id, posts one error card saying the conversation could not be resumed
and that a fork starts a new one, and tells the executor (`onConversationNotFound`) to skip
the no-result retry and its second card. The CLI exits by itself (verified on 2.1.293: it
also emits an error result carrying the requested id, and exits 1); ShipIt does not kill
it, because a kill can drop the `done` that ends the turn. Nothing is retried with a
replay.

### A replay only starts a conversation

A replay is armed by a fork for its new session, and still by the in-place rewinds above
(their redesign is a follow-up). `buildAgentRunParams` **reads** it — it no longer takes
it — and only when there is no stored id; a stored id is always resumed and a replay never
displaces it. The replay is retired when the CLI reports the conversation it started:
`SessionManager.setAgentSessionId` clears it in the same write. So a spawn that fails
before the CLI reports anything (a 413, a crash, a quota refusal) leaves it for the next
spawn, with no restore step to forget.

### Size

A replay rides in the spawn request, which the worker refuses above 1 MiB. So
`buildConversationReplay` keeps it under `REPLAY_INLINE_BUDGET_BYTES` (256 KiB, measured as
the JSON-escaped size, since a control character is six bytes in the request): when the
whole transcript does not fit, it writes it to `transcript.md` in the replay spill
directory (`/persist/replay/` in a container) and inlines only the most recent messages
that fit, with a line naming the file. `boundStoredReplay` cuts a replay stored before the
bound existed, since an unretired over-budget replay would fail every spawn. The body
limit itself is unchanged.

`buildConversationReplay` carries each message's tool calls, results and attachments as
indented detail lines, spilling any payload over 500 characters to a file it names instead:
`docs/144-rewind-fork-ux` U8.

Guards: `integration_tests/conversation-replay-retry.test.ts`,
`integration_tests/claude-message-flow.test.ts`, `services/replay.test.ts`,
`session-agent-run-params.test.ts`.

**Known limit.** The replay rides in the system prompt (`--append-system-prompt-file`),
which Claude Code does not store in its conversation file, so a fork's context is not in
the conversation after its first process restart. The decided fix is to deliver it as the
new conversation's first user message (follow-up work, tracked on the issue).

## Key files

- `src/server/orchestrator/ws-handlers/rollback-handlers.ts` — Three server-side handlers
- `src/server/orchestrator/services/replay.ts` — `buildConversationReplay()` (size bound) and `boundStoredReplay()`
- `src/server/orchestrator/session-agent-run-params.ts` — reads the replay into the system prompt when there is no stored id
- `src/server/orchestrator/sessions.ts` — replay storage; `setAgentSessionId` retires it
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — the only writer of the agent session id; the cannot-resume card
- `src/server/orchestrator/turn-executor.ts` — ends a turn whose conversation the CLI cannot resume
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
