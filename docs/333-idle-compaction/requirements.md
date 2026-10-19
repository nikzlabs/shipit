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

### Prior art: t3code

[pingdotgg/t3code#21682](https://github.com/pingdotgg/t3code/pull/21682)
("compact idle threads before the prompt cache expires", open on 2026-10-19)
does the same from its server: a sweep every minute and at each run's end
sends a system-authored `/compact` in the last 10% of the cache lifetime (at
least 2 minutes), never after the cache is cold. It is off by default and
uses a 200K-token floor, as requirements 5 and 6 do. It differs in scope: it
also compacts on a 5-minute cache (an API key) and on other providers with an
assumed 30-minute lifetime, where requirement 1 here covers only the one-hour
cache. It has no case for a stopped process, because t3code runs on the
user's machine; requirement 2 exists because ShipIt stops containers. Its
review found that settling a thread can interrupt a running idle compaction —
a hazard a ShipIt design must also answer.

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

5. Idle compaction is off by default. One global setting in Settings →
   Advanced turns it on.

6. An idle compaction runs only when the agent's context is 200K tokens or
   more.

7. A done session (docs/316) gets no idle compaction.

8. When ShipIt is over its memory budget, it stops other idle sessions before
   it stops a session that waits for its idle compaction. When it must still
   stop such a session, it compacts that session first and then stops it.

## Requirement provenance

Requirements 1 and 2 come from what the user asked for: the user wants ShipIt
users to get the benefit of the CLI's compaction before the cache expires,
even though ShipIt can stop a container before that time. Requirements 5 to 8
come from the user's answers on 2026-10-19 (below). Requirements 3 and 4 were
not asked for: each keeps a guarantee that already ships from becoming weaker —
docs/178 for how a compaction appears, and docs/295 req 9 and docs/324 req 6
for a failed compaction. They are kept apart so that the difference stays
visible.

## Open questions

None.

## Resolved questions

- 2026-10-19 — Is idle compaction on by default, or off until the user turns
  it on? Offered "on, with an off switch in Settings → Advanced"
  (recommended, as the CLI does in the terminal) or "off, opt-in in Settings →
  Advanced". The user chose off, opt-in. Recorded as requirement 5.
- 2026-10-19 — What is the minimum context size? Offered 200K tokens (the CLI
  default, recommended), 100K (the lowest the CLI allows) or a number the user
  can change. The user chose 200K. Recorded as requirement 6.
- 2026-10-19 — Does a done session get an idle compaction? ShipIt stops a done
  session's container after 10 minutes, so it would have to compact before
  that stop, and most done sessions get no next message. The user chose to
  skip done sessions. Recorded as requirement 7. A merged session that
  continues still compacts under docs/295.
- 2026-10-19 — Requirement 2 conflicts with the memory budget: what happens
  when ShipIt must stop a session that waits for its idle compaction? Offered
  "stop other idle sessions first, then compact and stop" (recommended), "stop
  at once and lose the benefit", or "compact first, in today's stop order". The
  user chose the first. Recorded as requirement 8. Its consequence: when
  ShipIt must stop a waiting session, the memory comes back after the
  compaction, not at once.
