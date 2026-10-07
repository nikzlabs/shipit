---
issue: planning#643
title: Agent-requested context compaction
description: A `shipit compact [instructions]` command, so the agent compacts its own context at a point it chooses and keeps what it names.
---

# 324 — Agent-requested context compaction: requirements

Builds on the compaction that already ships on four harnesses:
[docs/178 — Context Compaction](../178-context-compaction/plan.md) (the user's
`/compact` and the "Context compacted" card),
[docs/276 — Headless compaction triggers](../276-headless-compaction-triggers/plan.md)
(OpenCode and Grok), and
[docs/295 — Compact the context when a merged session continues](../295-compact-context-on-merge/plan.md)
(a compaction that ShipIt starts by itself).

The user's request, in their words: support a "compact [instructions]" CLI
command, "so an agent could compact the context itself at strategic points, for
example when switching between features and making sure to keep specific
instructions (in addition to the harness-native compaction)."

## Requirements

1. The agent can compact its own context with the command
   `shipit compact [instructions]`.

2. The agent decides when to compact, at points it chooses — for example when it
   finishes one feature and starts the next.

3. The instructions are optional. When the agent gives them, they say what the
   compaction must keep, so that the specific instructions the agent names are
   still known to it after the compaction.

4. The command is in addition to the harness-native compaction. The harness's
   automatic compaction, and the `/compact` that the user types, work as they do
   today.

5. The user can see in the chat transcript that a compaction ran. This is the
   same card that a `/compact` gives today.

6. If the compaction fails, no work and no message is lost, and the transcript
   says that the context was not compacted.

7. Where the session's harness cannot compact its context, the command tells the
   agent so at once, and nothing is scheduled.

8. The agent can add a note to the command. With a note, the agent gets a new
   turn after the compaction, with that note, and continues on its own. Without
   a note, the session waits for the user's next message.

9. On every harness, the first turn after the compaction gives the agent its
   instructions back, word for word. This is in addition to what the harness's
   own summary keeps.

10. When the user presses **Stop** on the turn that asked for the compaction,
    the compaction still runs, but the agent does not continue on its own: the
    session waits for the user's next message.

## Requirement provenance

Requirements 1 to 4 and 8 to 10 come from what the user asked for and decided.
Requirements 5 to 7 were
not asked for: each keeps a guarantee that already ships from becoming weaker —
docs/178 for how a compaction appears, docs/295 req 9 for a failed compaction,
and docs/295 req 10 plus every other `shipit` command for refusing at once what
cannot be done. They are kept apart so that the difference stays visible.

## Platform constraint (not a requirement)

The command runs as a tool call inside the agent's own turn. Only Claude in
streaming mode and Codex have a live process that could take a compaction
mid-turn; Grok and OpenCode compact only in a new spawn (verified at each
adapter's `compact()`). The one path that works on all four harnesses is a
compaction between turns, which is how ShipIt runs every between-turns
`/compact`. So the compaction happens after the turn that asked for it ends —
the same shape as
[docs/321 — Agent-requested container restart](../321-agent-requested-restart/requirements.md).

## Open questions

None.

## Resolved questions

- 2026-10-07 — After the compaction, does the agent continue on its own in a new
  turn, or does the session wait for the user's next message? Chosen: the agent
  chooses. With a note it gets a new turn with that note; without one the
  session waits. This covers an autonomous switch between features and a
  compaction at the end of a reply to the user. Requirement 8 added.
- 2026-10-07 — Codex and OpenCode ignore compaction instructions; only Claude
  and Grok honour them. How does requirement 3 hold there? Chosen: hand the
  instructions back word for word on every harness, not only where they are
  ignored — one behaviour everywhere. Requirement 9 added.
- 2026-10-07 — Does **Stop** on the requesting turn cancel the compaction?
  Chosen: the compaction still runs, but the agent does not continue on its own.
  Requirement 10 added.
