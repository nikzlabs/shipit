---
issue: planning#699
title: Compact an idle session before its prompt cache expires
description: ShipIt compacts a large, idle session's context shortly before its one-hour prompt cache expires, because the Claude CLI's own idle compaction never runs under ShipIt.
---

# 333 — Idle compaction (requirements)

Builds on the compaction that already ships:
[docs/178 — Context Compaction](../178-context-compaction/plan.md) (`/compact`
and the "Context compacted" card),
[docs/276 — Headless compaction triggers](../276-headless-compaction-triggers/plan.md),
[docs/295 — Compact the context when a merged session continues](../295-compact-context-on-merge/requirements.md)
(a compaction that ShipIt starts by itself) and
[docs/324 — Agent-requested context compaction](../324-agent-requested-compaction/requirements.md).

## Background

Claude Code 2.1.299 (2026-10-14) added idle compaction "in the terminal": a
conversation of 200K tokens or more that is left idle for about 54 minutes is
compacted before its one-hour prompt cache expires, so the next message does
not re-read all of it at cache-write price. `"idleCompaction": false` turns it
off, and `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` changes the 200K minimum (the
CLI raises any value below 100K to 100K).

**It never runs under ShipIt, even when the container stays alive.** Read in
the bundle of CLI 2.1.300, the version ShipIt pins: the idle timer arms only
when the CLI is interactive, or when its entrypoint is on a list of
first-party hosts (`claude-vscode`, `claude-desktop`, `remote` and others).
ShipIt runs Claude with `--print --input-format stream-json`
(`src/server/session/agents/claude/process.ts`), which makes the entrypoint
`sdk-cli`. A server-side feature flag also sets the mode, and the mode is off
when the flag gives no value.

**A timer inside the container would not be enough either.** ShipIt can stop
an idle session's container before the hour ends:
`src/server/orchestrator/idle-enforcer.ts` stops idle agent containers when
ShipIt is over its memory budget (sessions with no viewer, the one whose last
viewer left first goes first), stops a done session after 10 minutes
([docs/316](../316-done-sessions-return-memory/requirements.md)), and a ShipIt
update replaces containers.

## Requirements

1. When a session's agent context is large and the session has been idle for
   most of its one-hour prompt-cache lifetime, ShipIt compacts the context
   before the cache expires. The user's next message then does not re-read the
   whole earlier context.

2. A session gets the benefit of requirement 1 even when ShipIt stops the
   session's container while the session is idle.

3. The user can see in the chat transcript that an idle compaction ran. This
   is the same card that a `/compact` gives today (docs/178).

4. If an idle compaction fails, no work and no message is lost, and the
   transcript says that the context was not compacted.

## Requirement provenance

Requirements 1 and 2 come from what the user asked for: the user wants ShipIt
users to get the benefit of the CLI's compaction before the cache expires,
even though ShipIt can stop a container before that time. Requirements 3 and 4
were not asked for: each keeps a guarantee that already ships from becoming
weaker — docs/178 for how a compaction appears, and docs/295 req 9 and
docs/324 req 6 for a failed compaction. They are kept apart so that the
difference stays visible.

## Open questions

- Is idle compaction on by default, or off until the user turns it on? Where
  is the switch — one global setting in Settings → Advanced? A compaction is a
  real model call: if the user never comes back, its cost is a waste, and a
  user who comes back finds the agent working from a summary, not the full
  conversation.
- What is the minimum context size? The CLI uses 200K tokens by default and
  allows no less than 100K. (docs/295 req 15 uses a 50K floor, for a
  different purpose.)
- Does a done session (docs/316) get an idle compaction? ShipIt stops a done
  session's container after 10 minutes, so under requirement 2 a done session
  would need its compaction before that stop. Most done sessions get no next
  message, so their compaction would usually be a waste.
- Requirement 2 conflicts with the memory budget. When ShipIt is over its
  budget and must stop a session that waits for its idle compaction, may it
  compact first, so the memory comes back about a minute later? Or must the
  memory come back at once, so that this session loses the benefit?

## Resolved questions

None yet.
