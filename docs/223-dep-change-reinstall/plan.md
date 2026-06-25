---
title: Auto-reinstall on dependency changes from git operations
description: Re-run agent.install + restart gated services when a lockfile/manifest changes — including via git reset/checkout/rebase, not just direct edits.
issue: https://github.com/nikzlabs/shipit/issues/1622
---

# Dependency-change auto-reinstall (#1622)

## Problem

Resetting a session branch to a commit that added dependencies left the preview
500'ing on `Failed to resolve import "react-router-dom"`. The dev Compose
service kept its stale `node_modules` and nothing re-ran install. The
agent-facing docs promised *"changes to lockfiles trigger an automatic install +
service restart (30s cooldown)"* — but that behavior **was never implemented.**

The orchestrator's `file_changes` SSE handler reacted **only** to compose config
files (`shipit.yaml`, `docker-compose.yml`/`.yaml`, `compose.yml`/`.yaml`) by
calling `serviceManager.reconcile()`. No code path turned a lockfile change into
a reinstall — so neither a git `reset`/`checkout`/`rebase` *nor* a direct
lockfile edit triggered one.

## Approach

Wire dependency-input detection into the existing `file_changes` handler and
invoke the **already-built** mid-session reinstall machinery. Because the
filesystem watcher (chokidar) reports the files a git operation rewrites just
like any edit, a single hook covers git operations *and* direct edits.

On a `file_changes` event, if any changed path is one of this session's
**dependency input files**, run a bracketed reinstall:

```
serviceManager.setInstallRunning(true)   // holds + tears down gated services
await runner.runInstall(installCommands)  // worker /install marker decides skip vs run
serviceManager.setInstallRunning(false, { failed })  // relaunches them (or latches to error)
```

The trigger is always safe: the worker's `/install` marker gate
(`install-controller.ts`) compares the stamped `sourceCommit` + `depsHash`
against the current checkout and **skips fast** when nothing actually changed.
So we trigger on any dep-input change and let the marker decide skip-vs-run.

### Why the machinery already supports this

- `ContainerSessionRunner.runInstall()` is re-entrant — `signalInstallComplete()`
  nulls `_installComplete`, so a second call after completion starts a fresh
  install (the in-flight guard only joins genuinely concurrent calls).
- `ServiceManager.setInstallRunning(true)` on a `false→true` transition runs
  `holdGatedServicesForReinstall()`; `setInstallRunning(false, { failed })` opens
  the gate and `startGatedServices()` relaunches them. This is the same bracket
  `setupServiceManager` uses for the initial install.
- `resolveDepsHashInputs(installCommands, installInputs)` (`shared/deps-hash.ts`)
  yields the precise input set (e.g. `["package.json", "package-lock.json"]`), or
  `null` for a non-content-keyable install (`./build.sh`) → empty watch set → no
  auto-reinstall (the safe default, consistent with content-keying being off).

### Throttle

A 30s cooldown (`DEP_REINSTALL_COOLDOWN_MS`) throttles reinstalls so a git
operation's burst of file writes, or the reinstall's own lockfile rewrite, can't
spin an install loop. Leading-edge: fire at once when idle; a change arriving
while a reinstall is in flight or within the window sets a pending flag and arms
a single trailing timer, so the final lockfile state is always installed.

## Key files

- `src/server/orchestrator/container-session-runner.ts` — `setDepReinstallInputs`,
  `isDepInputChange`, `maybeReinstallForDepChange` (throttle), `reinstallForDepChange`
  (the bracket); the `file_changes` handler calls into them; dispose clears the timer.
- `src/server/orchestrator/service-manager-setup.ts` — pushes the install commands +
  resolved dep-input set to the runner via `setDepReinstallInputs`.
- `src/server/shared/deps-hash.ts` — `resolveDepsHashInputs` (reused, unchanged).
- `src/server/orchestrator/container-session-runner.test.ts` — predicate + throttle unit tests.

## Edge cases

- **No compose stack**: still reinstalls (refreshes the agent container's
  `node_modules` for tooling); the `setInstallRunning` bracket is inert when no
  ServiceManager exists.
- **Agent-run `npm install`**: rewrites the lockfile → triggers a reinstall whose
  marker check + cooldown make it a fast skip / single pass, and correctly
  restarts the dev service to pick up the new dependency.
- **`package.json`-only edit with an out-of-sync lock**: `npm ci` may fail →
  surfaces as `install_error` + gated services latched to a clear message
  (better than a silent stale preview).
- **Non-keyable install** (`./build.sh`, codegen): no watch set → no auto-reinstall.

## Out of scope

- A stale-dependency hint on import-resolve failures in the preview.
- Sharing `node_modules` into non-overlay sessions (repo-backed sessions already
  share the overlay dep store with Compose services — docs/183 Phase 5).

## Verification

- `npm run typecheck`, `npm run lint:dev`, and the co-located unit test
  (4 cases) pass in-session.
- Integration coverage (CI-run; integration tests OOM a session container):
  extend the install-gate test so a `file_changes` event naming
  `package-lock.json` triggers `runInstall` + the gated-service hold→restart,
  and an unrelated path does not.
