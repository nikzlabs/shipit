---
issue: planning#700
title: Re-attach the idle resident Claude process after an orchestrator restart
description: After an orchestrator restart that keeps a session's container, the session's next turn runs on the Claude process that survived, so it reads the warm prompt cache instead of writing the whole conversation again.
---

# 334 — Re-attach the resident Claude process (requirements)

Builds on [docs/333 — Idle compaction](../333-idle-compaction/requirements.md),
whose requirement 16 is an exception that ends with this feature.

## Background

With live steering on (the default), a Claude session keeps one resident CLI
process between turns. The first `--resume` in a new CLI process misses the
prompt cache from the end of the system prompt and tools onwards: it writes
the whole conversation to the cache again, even inside the cache lifetime. A
resume of an already-resumed session is warm. Probe on 2026-10-19, Claude Code
2.1.300: [docs/333 plan, "Verify first"](../333-idle-compaction/plan.md#verify-first).

An orchestrator restart keeps the container and its resident process
(`disposeAll({ preserveAgent: true })` in `shutdown-manager.ts`; the worker
keeps the process in `agent-controller.ts`). But the restarted orchestrator
holds no link to that process, so the session's next turn starts a new one
and pays the full cache write. Restart adoption reconnects only to a turn
that is in flight, or that the CLI starts by itself.

## Requirements

1. After an orchestrator restart that keeps a session's container and its
   resident Claude process, the session's next turn runs on that process. The
   turn then reads the warm prompt cache and does not write the whole
   conversation to the cache again. This applies to a turn the user sends and
   to a turn ShipIt starts by itself.

2. The exception of docs/333 req 16 ends: after such a restart, the session
   gets its idle compaction as any other session does (docs/333 reqs 1 and 2).

3. A process that a restarted orchestrator takes over is still replaced by a
   new process when the session no longer matches what the process was
   started with: another harness, model, service or account, another value of
   the session status card setting, a pending rewind, or other MCP servers.
   The permission mode that the user selects applies to the turn.

4. Taking over the process loses no work: a turn the process starts by itself
   is still followed, and its background tasks keep running.

## Requirement provenance

Requirements 1 and 2 come from planning#700 (its problem and proposal) and
from docs/333 req 16, which names this work as its end. Requirements 3 and 4
were not asked for: each keeps a guarantee that already ships from becoming
weaker — the spawn guards of `resident-spawn-guard.ts` and the permission-mode
switch on a reused process (3), and restart adoption of a turn the CLI starts
by itself (planning#639) (4). They are kept apart so that the difference
stays visible.

## Open questions

- planning#700 lists other paths that drop the resident process
  (`setAgent(null)`), and says that each one that does not have to replace it
  could keep it. Which of them keep the process?
- Restart adoption of a turn in flight has the gap of requirement 3 today: the
  restarted orchestrator does not know what the adopted process was started
  with, so a later model change never replaces it. Does requirement 3 cover
  those processes too?

## Resolved questions

None yet.
