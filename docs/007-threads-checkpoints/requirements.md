---
issue: planning#610
title: Rollback, rewind and fork — requirements
description: What a rewind, its undo and a fork must do to the agent's conversation, from the owner's rule of 2026-10-15.
---

# Rollback, rewind and fork — requirements

Design: [plan.md](plan.md).

1. ShipIt never sends the conversation to the agent CLI again on its own. The only
   replay is a fork's, which starts the fork's new conversation.
2. ShipIt never clears or replaces the agent session id it stored. The only id it writes
   is one the CLI reported for its own conversation.
3. A code-only rewind, and the undo of one, leave the agent's conversation as it is. The
   next prompt tells the agent, in one line, that the code was rolled back and to which
   commit.
4. A chat rewind, a chat-and-code rewind, and the undo of either make the agent's
   conversation end where the chat ends. The agent CLI does this itself, by starting a
   new conversation from the message at that point (Claude Code: `--resume <stored id>
   --resume-session-at <message id> --fork-session`). ShipIt stores the new
   conversation's id only when the CLI reports it.
5. ShipIt records the CLI's id of each chat message, so that requirement 4 has a message
   to start from.
6. When the agent cannot start a conversation from a message (Codex), ShipIt refuses an
   in-place chat rewind and offers fork instead.
7. After a rewind, the next turn never goes to an agent process that still holds the
   conversation from before the rewind.
8. A fork's replay is the first user message of the fork's new conversation, not part of
   the system prompt, so the agent CLI stores it and it is still there after the agent
   process restarts.
9. When the chat has no recorded message to start from at the rewind point, ShipIt
   refuses an in-place chat rewind and offers fork, as in requirement 6. This applies to
   a rewind to the start of the chat, and to messages from before ShipIt recorded their
   ids.

## Requirement provenance

Requirements 1–8 are the owner's words (below). Requirement 9 is derived, not decided:
with no message to start from, the only ways to keep the conversation in step with the
chat are an empty conversation started without the stored id, or a replay — and
requirements 1 and 2 forbid both outside a fork. It removes the in-place "rewind chat to
the start"; a fork from that point gives the same empty chat. It is flagged in the pull
request for the owner to confirm or override.

## Open questions

## Resolved questions

- 2026-10-15 — After a production incident, may ShipIt re-send the conversation or
  reset the stored agent session id? The owner: "ShipIt MUST NEVER re-send the
  conversation to the agent CLI, and MUST NEVER delete or replace the agent session id
  stored in the DB. Claude Code manages its conversations itself: ShipIt passes the
  stored id to `--resume` and nothing else. The only legitimate use of a transcript
  replay is starting a new conversation via fork." (reqs 1, 2)
- 2026-10-15 — What do the in-place rewinds do to the conversation? The owner, relayed
  by the parent session: a code-only rewind and its undo do not touch the conversation
  and queue a one-line notice; a chat or chat-and-code rewind and their undo use Claude
  Code's own fork at a message, storing only the id the CLI reports, with the CLI message
  id recorded per chat row; Codex refuses an in-place chat rewind and offers fork; until
  that lands, an idle resident `claude` process is retired on any rewind; and a fork's
  replay is the new conversation's first user message. (reqs 3–8)
