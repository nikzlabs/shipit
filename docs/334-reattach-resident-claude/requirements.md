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
process between turns. planning#700 rests on a docs/333 probe: the first
`--resume` in a new CLI process missed the prompt cache from the end of the
system prompt and tools onwards, so it wrote the whole conversation to the
cache again ([docs/333 plan, "Verify first"](../333-idle-compaction/plan.md#verify-first)).
The probe of this feature did not reproduce that through ShipIt's own spawn
path: there the first resume read the whole conversation from the cache
([plan.md, "Probe"](./plan.md#probe)).

An orchestrator restart keeps the container and its resident process
(`disposeAll({ preserveAgent: true })` in `shutdown-manager.ts`; the worker
keeps the process in `agent-controller.ts`). But the restarted orchestrator
holds no link to that process, so the session's next turn starts a new one
and ends the old one, with its background tasks. Restart adoption reconnects
only to a turn that is in flight, or that the CLI starts by itself.

## Requirements

1. After an orchestrator restart that keeps a session's container and its
   resident Claude process, the session's next turn runs on that process. The
   turn then reads the warm prompt cache and does not write the whole
   conversation to the cache again. This applies to a turn the user sends and
   to a turn ShipIt starts by itself. Only the restart changes: a path that
   replaces the process for another reason still replaces it.

2. The exception of docs/333 req 16 ends: after such a restart, the session
   gets its idle compaction as any other session does (docs/333 reqs 1 and 2).

3. A process that a restarted orchestrator takes over — an idle one, or one
   with a turn in flight — is still replaced by a new process when the session
   no longer matches what the process was started with: another harness, model, service or account, another value of
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
stays visible. Requirement 3's "or one with a turn in flight", and requirement
1's last sentence, come from the user's answers on 2026-10-19 (below).

## Open questions

None.

## Resolved questions

- 2026-10-19 — planning#700 lists other paths that drop the resident process
  (`setAgent(null)`), and says that each one that does not have to replace it
  could keep it. Which of them keep the process? Offered "none, only the
  restart" (recommended: each path ends a process that exited or crashed,
  that holds a rejected or removed credential, that the user killed, that a
  rewind must fork, or that a rebase must stop while git rewrites the tree;
  the answer path of `send-message.ts` already keeps a resident process),
  "also the rebase conflict-resolution step" (changes docs/329's rule that no
  agent process stays alive while git rewrites the tree), or "also after an
  auth failure" (needs a probe that the CLI reads a refreshed token). The user
  chose only the restart. Recorded in requirement 1.
- 2026-10-19 — Restart adoption of a turn in flight has the gap of requirement
  3 today: the restarted orchestrator does not know what the adopted process
  was started with, so a later model change never replaces it. Does
  requirement 3 cover those processes too? Offered "yes, fix both"
  (recommended: the same record serves both) or "no, idle processes only, and
  file a separate issue". The user chose to fix both. Recorded in requirement
  3.
