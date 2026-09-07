---
issue: planning#515
title: A Compose stack must not outlive the session that owns it
description: Reap per-session Compose stacks that survive an orchestrator restart, and never wipe a workspace a service still has mounted.
---

# 290 — A Compose stack must not outlive the session that owns it

## Requirements

1. A Compose stack never outlives its session's ability to route to it by more
   than one orchestrator restart.
2. A workspace is never wiped while a service still has it mounted.

## Open questions

- (none)

## Resolved questions

- 2026-09-06 — *The report specified `docker compose -p <project> down
  --remove-orphans` as the teardown. Is the compose CLI the right instrument?*
  No, and the reason is req 1 itself, not convenience. Reaping has to reach a
  stack whose compose file was deleted by `light → evicted`, and it must NOT
  reach the docs/172 egress sidecars, which carry `shipit-parent-session` so
  destroy-time cleanup reaps them and which a surviving agent container still
  needs for DNS and HTTPS. Matching on Compose's own
  `com.docker.compose.project` label names exactly the stack, needs no file, no
  cwd and no CLI, and is testable against a fake Docker. The project NAME is
  still the compose CLI's (`composeProjectName`, shared with `ComposeCli.args`),
  so the two can't drift.
- 2026-09-06 — *Reserved (always-on) sessions are exempt from the reaper on the
  grounds that `restoreReservedPreviews` rebuilds their routing first. Does it?*
  Not for a session whose agent container survived the restart — it skipped
  those on "its container is running", leaving no runner, no manager, an
  unroutable stack and a reservation quietly broken. That made the exemption
  rest on a guarantee the code did not provide, and left req 1 unmet for exactly
  the sessions docs/241 cares most about. Fixed at the source: the restore now
  keys on "no runner" rather than "no running container". `getOrCreate` adopts a
  rediscovered container (the same call the docs/240 turn-adoption sweep makes)
  rather than creating a second one, so nothing is duplicated.
- 2026-09-06 — *Should the shutdown hook await its `compose down`s, with a
  raised `stop_grace_period`?* No. 20+ parallel `compose down`s do not fit in
  Docker's grace period, and making every update slower to reclaim something
  nobody is waiting on is the wrong trade — the reporter's own instruction was
  "do not make the update slower to fix this". The un-awaited stop stays as a
  best-effort head start; req 1's guarantee is the boot reconciliation, and the
  three comments claiming shutdown already provided it are corrected.
