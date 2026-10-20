---
issue: planning#610
description: Rollback and fork, the conversation replay that starts a fork's conversation, and why ShipIt never resets a stored one.
---

# Rollback System

Requirements: [requirements.md](requirements.md). The rewind UI — rewind points between
turns, the confirmation, undo — is `docs/144-rewind-fork-ux`; this doc is what each action
does to the agent's conversation.

## What each action does to the conversation

| Action | Chat | Code | Agent conversation |
|---|---|---|---|
| Rewind code | kept, later rows dimmed | reset to the gap's commit | unchanged; the next prompt carries a one-line notice (req 3) |
| Rewind chat | cut at the gap | unchanged | forked at the gap's message (req 4) |
| Rewind chat and code | cut at the gap | reset | forked at the gap's message (req 4) |
| Fork | copied to a new session | new branch at the gap's commit | new conversation; the replay is its first user message (req 8) |

An undo restores what the action changed and nothing else: a code undo removes its notice
if no turn read it yet, and a chat undo restores the rewind point that was pending before
(normally none). An undo is only possible before the next turn starts (`docs/144-rewind-fork-ux`
D8), so no fork has happened yet and the stored conversation still holds every message.

### Commit linking

After each auto-commit, the server captures the parent commit hash (HEAD before commit) and the new commit hash. These are linked to the last assistant message via a `commit_linked` WS event and persisted in chat history.

### Rewind code (req 3)

`git reset --hard` to the gap's commit, the rows past the gap marked `rolledBack`, and
`appendPendingAgentNotice` queues one line ("The user rolled the code back to commit
`abc1234`; …"). The pending notice rides the next prompt the way every pending agent notice
does (`agent-execution.ts`), so it reaches a resident process too, and a turn that never
reaches an agent puts it back (planning#609). The stored id, the resident process and the
conversation are not touched. The undo removes that exact line from the pending notice.

### Rewind chat, and chat and code (reqs 4, 5, 7)

Claude Code forks a stored conversation at one of its messages:
`claude --resume <stored id> --resume-session-at <message uuid> --fork-session`. The new
conversation holds the messages up to and including that one, with their uuids unchanged,
and reports its own id in `init`; the stored file is not modified. Verified on 2.1.300 in
`-p` and stream-json input mode. An unknown uuid is an error result, "No message found
with message.uuid of: …", exit 1, and no new file.

**The message id of each row (req 5).** The Claude adapter passes the CLI's `uuid` on as
`messageId` on `agent_assistant`, `agent_tool_result` and `agent_user_replay`.
`agent-listeners.ts` writes the latest one onto the chat group it fed (`agentMessageId`):
assistant output the model wrote (never `synthetic` text) and the tool results attached to
that group — but not past a steer the CLI has read, which a lone question or plan tool
merged into the group would cross (`stampLastGroup`). The turn prompt's echo stamps its
user row, found by the row id the persist returned (`turn-executor.ts`,
`recordUserMessageAgentId`): the first matching echo of the attempt, written once the
listener keeps that attempt's conversation (`onConversationKept`, the same decision that
stores its id), since an attempt whose conversation is not kept — unanswered, or a
"successful" result the listener reads as a quota refusal — names a message no stored
conversation has. A retry's stamp replaces it. The CLI echoes a prompt it reads before it
answers it, so the echo is in hand when an idle process answers. The echo may
carry the worker's Node runtime notice before the prompt, and still counts for the stamp;
the turn-ownership reading stays an exact match. The id is the `agent_message_id` column
of `messages`.

Measured on 2.1.300, so some user rows have no id: a prompt the CLI reads while idle is
stored as a user message under its echo's id, but a message it reads mid-turn — a steer,
or a prompt that went in behind a turn of the CLI's own — is stored as a `queued_command`
attachment under a different id. So a steer is never stamped, and the prompt is not
stamped when the CLI started a turn of its own first. One-shot mode does not echo user
messages at all.

**The fork point.** `forkPointBefore` walks back from the gap: the first row with an id is
the point; rows ShipIt wrote itself (notices, cards, errors) carry none and are skipped; a
user row with no id ends the search with no point, since the conversation would lose that
prompt. No point, or an agent without the `forksAtMessage` capability (Codex), refuses the
in-place rewind with a reason that names fork (reqs 6, 9). The rewind preview carries the
same reason as `unavailableReason`, and the rewind menu disables the item and shows it.

**Applying it.** The rewind stores the point in `sessions.agent_resume_at` and keeps the
stored id. `buildAgentRunParams` passes it as `resumeAt` with the stored id, and the Claude
process adds `--resume-session-at <uuid> --fork-session` after `--resume`. The CLI reports
the fork's id like any other, and `setAgentSessionId` retires the point in the same write,
only when the id it writes differs from the stored one. A spawn that fails first keeps the
point for the next spawn; an unanswered failure stores no id (`agent-listeners.ts`).

**No resident holds the old conversation (req 7).** A rewind of the chat retires the idle
resident process at once — a CLI-started turn (a background task finishing) would
otherwise continue the old conversation — and both turn paths (`agent-execution.ts`,
`dispatched-turn.ts`) retire a resident while a point is pending
(`releaseResidentOnPendingRewind`). A code-only rewind keeps the resident: its
conversation is unchanged. The rewind checks that no turn runs and then awaits file and
git work without holding turn admission, as it did before; a turn admitted in that window
keeps its process, and the next turn's start retires it.

**A point the CLI cannot find.** `agent-listeners.ts` matches the CLI's stderr line like
"No conversation found": it posts one card that says the conversation could not be rewound
and that a fork continues from this point, keeps the stored id and the point, and ends the
turn without the no-result retry.

### Fork as new session (req 8)

1. Truncates chat history to the rollback point
2. Creates new session via `forkSession()` with `startPoint: parentCommitHash`
3. Saves truncated history and conversation replay to the new session; the copied rows
   lose their `agentMessageId`, which names messages of the parent's conversation
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

Only a fork arms a replay, for its new session. `buildAgentRunParams` **reads** it — it no
longer takes it — and only when there is no stored id; a stored id is always resumed and a
replay never displaces it. It puts the replay in front of the turn's prompt, so it is the
first user message of the new conversation and the CLI stores it (req 8); the system
prompt is not stored, and a replay there was lost at the first process restart. The
executor still knows the prompt in the CLI's echo, which has the replay in front.
The replay is retired when the CLI reports the conversation it started:
`SessionManager.setAgentSessionId` clears it in the same write. So a spawn that fails
before the CLI reports anything (a 413, a crash, a quota refusal) leaves it for the next
spawn, with no restore step to forget. A compaction asked for before the fork's first turn
has nothing to compact, and the CLI reads `/compact` only as the whole message: that turn
sends the replay alone, without the compaction, and so starts the conversation.

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
`integration_tests/claude-message-flow.test.ts`, `integration_tests/rewind-conversation.test.ts`,
`integration_tests/turn-prompt-message-id.test.ts`,
`services/replay.test.ts`, `services/rewind-conversation.test.ts`,
`session-agent-run-params.test.ts`.

**Known limits.** A fork whose first message is a `/goal` command sends the replay in
front of it, so the CLI reads the command as text. A rewind point before a compaction
boundary forks the full messages from before the compaction, which can be longer than the
context window; the CLI then compacts again. A goal set through the goal control process
while a rewind point is pending is set on the conversation before the fork. A compaction
asked for before a fork's first turn, which sends the replay instead, is still handled by
ShipIt as a compaction turn: no live steering during it, and no status-card nudge after.

## Key files

- `src/server/orchestrator/ws-handlers/rollback-handlers.ts` — rewind, preview and undo handlers
- `src/server/orchestrator/services/rewind-conversation.ts` — the fork point, the refusal reasons, the code rewind notice
- `src/server/orchestrator/services/replay.ts` — `buildConversationReplay()` (size bound) and `boundStoredReplay()`
- `src/server/orchestrator/session-agent-run-params.ts` — puts the replay in front of the first prompt; passes the rewind point
- `src/server/orchestrator/sessions.ts` — replay and rewind point storage; `setAgentSessionId` retires both
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — the only writer of the agent session id; records each row's message id; the cannot-resume and cannot-rewind cards
- `src/server/orchestrator/resident-spawn-guard.ts` — `releaseResidentOnPendingRewind`
- `src/server/session/agents/claude/process.ts` — `--resume-session-at` and `--fork-session`
- `src/client/components/RewindPoint.tsx` — the rewind menu; disables a chat rewind the agent cannot make

## Edge cases

- **During streaming**: rewind points are disabled while a turn runs (`docs/144-rewind-fork-ux` D3)
- **Multiple rollbacks**: Each message tracks its own `parentCommitHash`, so sequential rollbacks work correctly
- **Chat history safety**: `.vibe-chat-history/` must be in `.gitignore` so `git reset --hard` doesn't clobber it
