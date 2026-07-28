---
issue: https://linear.app/shipit-ai/issue/SHI-242
description: Re-read shipit.yaml and the compose file when the workspace changes under a live session — including orchestrator-side rewrites like a rebase.
---

# Mid-session config reload

A session reads `shipit.yaml` **once**, at setup. Everything it contributes —
which compose file to parse, whether services get the Docker socket, what
`agent.install` runs — was then frozen for the session's whole life. The only
mechanism that re-examined config afterwards was the in-container inotify file
watcher, and it re-parsed only the *compose file*, never `shipit.yaml` itself.

That made this reproducible and confusing:

> I rebase a session onto the latest main and the changes to `shipit.yaml` are
> not picked up — in particular, new services don't appear.

## The two failures

### 1. The trigger was the wrong signal

Compose re-evaluation hung off `file_changes` events from
`FileWatcher` (`src/server/session/file-watcher.ts`), which runs **inside the
session container**. A rebase is executed by the **orchestrator**, in a
different container, against the same bind-mounted workspace. Depending on that
watcher to observe a foreign-container write is fragile in principle, and in
practice the watcher may not even be running:

- `/files/watch` is a single best-effort `POST` per runner
  (`startWorkerResources`), fired once behind the `_workerResourcesStarted`
  latch. If it fails, or the worker restarts under a live runner, the watcher
  stays dead for the rest of the session — **silently**. No file-tree updates,
  no compose reconcile.
- Reproduced live: a session whose watcher had never started ignored a direct
  edit to `docker-compose.yml` entirely; a manual `POST /files/watch` answered
  `{ watching: true }` (a *fresh* start, not `existing: true`), after which the
  very same edit reconciled within a second.

### 2. Even a healthy trigger re-read the wrong file

`ServiceManager.reconcile()` re-parses `this.composeConfig.file`. But
`composeConfig` is the `compose:` block captured from `shipit.yaml` at
construction. So a rebase that moved the compose path, flipped
`compose.docker-socket`, or changed `agent.install` was invisible no matter how
the reconcile was triggered.

## Design

**The orchestrator knows when it rewrote the tree, so it says so.** Config
re-evaluation is a first-class operation any workspace-mutating flow invokes,
with the file watcher as one caller among several rather than the only one.

`SessionRunnerInterface.reevaluateWorkspaceConfig()` is that entry point.
Callers:

| Caller | Why |
|---|---|
| `file_changes` SSE handler (`container-session-runner.ts`) | A config file was edited in-container. |
| `runRebaseFlow` (`services/rebase-driver.ts`) | Rebase/sync replaced the working tree. Fires on the clean and conflicts-resolved paths only — `up_to_date` never touched the tree. |
| `POST /git/rollback` (`api-routes-git.ts`) | Rollback rewrote the tree from the orchestrator. |

It resolves to `applyShipitConfigChange` (`service-manager-setup.ts`), wired by
the runner registry. That function re-reads `shipit.yaml` from disk and applies
the delta:

- **No `ServiceManager` yet** → delegate to `setupServiceManager`, which reads
  everything from scratch and owns install. This is the "compose was just added"
  case.
- **Parse error** → surface `compose_error` and keep the running stack. A
  half-written `shipit.yaml` (mid-edit, or conflict markers from a merge) must
  not tear down a working preview.
- **`agent.install` changed** → re-record the dep-reinstall inputs and re-run,
  bracketed by the install gate and the existing reinstall cooldown (so a burst
  of rewrites coalesces into one trailing install). The worker's marker gate
  makes a no-op re-run cheap.
- **`compose:` removed** → stop the stack and emit `compose_not_configured`.
  Gated on a *trustworthy* read: `resolveShipitConfig` falls back to defaults
  (which carry `compose: undefined`) for a file that is missing **or** merely
  unreadable, and only the former is a real removal. A transient read failure
  while git rewrites the tree keeps the running stack.
- **otherwise** → `ServiceManager.updateComposeConfig()` (adopt the new file /
  docker-socket) then `reconcile()`.

`ContainerSessionRunner.appliedInstallCommands` is the record of what
`agent.install` the session is currently running — the diff basis. It is now
recorded even for an empty command list (an empty list still means "no
auto-reinstall", exactly as before).

### Watcher self-heal

Independently of the above, `/files/watch` is re-issued on **every** SSE stream
open (`onSseOpen`), not just once per runner. The worker endpoint is idempotent
(`{ existing: true }` when already watching), so this costs nothing and closes
the "watcher never started / worker restarted → dead for the session" hole that
also breaks live file-tree updates.

## Deliberate non-goals

- Config is **not** re-read on a timer or on every turn. It is re-read when
  something known to change the workspace happened.
- A `compose.file` path change reconciles under the same compose project name;
  services dropped from the new definition are removed by the existing
  `--remove-orphans` on `compose up`.

## Key files

| File | Role |
|------|------|
| `src/server/orchestrator/service-manager-setup.ts` | `applyShipitConfigChange` — the config delta applier; `ServiceSetupDeps` shared with `setupServiceManager` |
| `src/server/orchestrator/container-session-runner.ts` | `reevaluateWorkspaceConfig()`, `appliedInstallCommands`, `requestDepReinstall()`, watcher self-heal in `onSseOpen` |
| `src/server/orchestrator/service-manager.ts` | `updateComposeConfig()` — adopt a freshly-resolved `compose:` block |
| `src/server/orchestrator/compose-cli.ts` | `setComposeFile()` — retarget the compose file |
| `src/server/orchestrator/services/rebase-driver.ts` | Calls the re-evaluation after a rebase that changed the tree |
| `src/server/orchestrator/api-routes-git.ts` | Same, after a rollback |
| `src/server/orchestrator/runner-registry-factory.ts` | Wires `onComposeConfigChanged` → `applyShipitConfigChange` |
