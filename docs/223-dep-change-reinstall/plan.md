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

## The watcher is not the only trigger (nikzlabs/shipit#2429)

The approach above rests on one assumption — *"the filesystem watcher reports
the files a git operation rewrites just like any edit"* — and that assumption
holds only for a git operation run **inside** the container. It does not hold
for the rewrites the **orchestrator** performs on the session from outside it:
the watcher is started best-effort with a single fire-and-forget POST, and it
watches a bind mount written to from another container, so a cross-mount event
can be missed entirely — or the watcher was never started at all.

The reported failure was an idle session ShipIt rebased onto the latest
`origin/main` and force-pushed. The incoming commits changed `package.json` and
the lockfile, `agent.install` never re-ran, and the container kept the pre-rebase
`node_modules`. The dev server started fine and then failed every request with
`Failed to resolve import "<new-dependency>"` — while `shipit service list` still
reported the service as `running`, and a restart did not help, because the usual
compose guard is `[ -d node_modules ] || npm ci` and the directory existed. It
was just the wrong contents. `npm ci` by hand fixed it in seconds; the cost was
the diagnosis.

The fix says it directly instead of hoping for an inotify event. The
orchestrator knows exactly when it rewrote the tree, which is the same reasoning
`reevaluateWorkspaceConfig` (docs/234) already records for the *config* half of
the same rewrite — that half was wired and this one was not.

`onWorkspaceRewritten` (`workspace-rewrite.ts`) is the one call every such path
now makes, and it fires both halves in order: the config re-read first, because
`applyShipitConfigChange` synchronously applies an incoming `shipit.yaml`'s
`agent.install` / `install-inputs` to the runner, so the dependency check that
follows evaluates the *incoming* config. Its four callers are the sync/rebase
driver, the rollback route, the explicit `shipit branch reset-to-base`, and the
pre-turn auto-reset of a merged branch.

**It does not diff the changed paths.** The caller knows it rewrote the tree; it
does not have to work out what changed, because the worker's `/install` marker
already answers that question from the same data — it is content-keyed on a hash
of exactly these input files (docs/197), so an unchanged lockfile matches and
returns `{ skipped: true }` in milliseconds while a changed one misses and
reinstalls. A path diff would be a second implementation of that comparison, and
one that has to get renames, `./` prefixes and a failed `git diff` right to avoid
falling back into the silence it exists to remove.

The gate is the same one `isDepInputChange` applies: a session with **no**
dep-input set (a non-content-keyable install) is skipped, since its `null` deps
hash can never match the marker and every sync would reinstall from scratch.
That session keeps this feature's documented safe default — no auto-reinstall.

## Key files

- `src/server/orchestrator/container-session-runner.ts` — `setDepReinstallInputs`,
  `isDepInputChange`, `maybeReinstallForDepChange` (throttle), `reinstallForDepChange`
  (the bracket); the `file_changes` handler calls into them; dispose clears the timer.
  `notifyWorkspaceRewritten` is the #2429 entry point for an orchestrator-side rewrite.
- `src/server/orchestrator/workspace-rewrite.ts` — `onWorkspaceRewritten`, the shared
  "the orchestrator rewrote this tree" call (config re-read + dependency re-check).
- `src/server/orchestrator/services/rebase-driver.ts`,
  `src/server/orchestrator/api-routes-git.ts` (rollback + `reset-to-base`),
  `src/server/orchestrator/pre-turn-reset-hook.ts` — its four callers.
- `src/server/orchestrator/service-manager-setup.ts` — pushes the install commands +
  resolved dep-input set to the runner via `setDepReinstallInputs`.
- `src/server/shared/deps-hash.ts` — `resolveDepsHashInputs` (reused, unchanged).
- `src/server/orchestrator/container-session-runner.test.ts` — predicate + throttle unit tests.
- `src/server/orchestrator/workspace-rewrite.test.ts` — ordering + both-halves-fail-safe.

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
- **Non-keyable install** (`./build.sh`, codegen): no watch set → no auto-reinstall,
  on the watcher path and on the #2429 orchestrator-rewrite path alike.
- **A rewrite that changes both `shipit.yaml` and the lockfile**: the config
  re-read may already have requested a reinstall (a changed `agent.install`), and
  the dependency check then asks again. The 30s cooldown coalesces the two into
  one trailing pass rather than stacking installs.

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
