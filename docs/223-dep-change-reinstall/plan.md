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

A 30s cooldown (`DEP_REINSTALL_COOLDOWN_MS`) paces reinstalls, so a git
operation's burst of file writes coalesces into one pass. Leading-edge: fire at
once when idle; a change arriving while a reinstall is in flight or within the
window sets a pending flag and arms a single trailing timer, so the final
lockfile state is always installed.

**The cooldown does not break an install loop, and this doc used to claim it
did.** A burst is finite, so pacing ends it; a *self-sustaining writer* is not,
and pacing it only sets its period. The production case (planning#2503) is a
compose service whose own `command:` re-runs its package manager over the same
bind mount the watcher watches — `sh -c "npm install && npm run dev"`. Its
`npm install` rewrites `package-lock.json`, the watcher reports a dep-input
change, the cooldown fires 30s later, the service is torn down, the install
skips, the service restarts and runs `npm install` again. Five sessions were
observed cycling at exactly 30.000s with no drift, for 84 cycles on the worst
one. The undrifting period is the evidence: a throttle that was breaking the
loop would show it decaying, not keeping time.

What makes such a repository harmless is the fix below — a no-op reinstall costs
nothing — not the cooldown.

### The bracket is applied only when the install really runs (planning#2503)

`setInstallRunning(true)` is a `docker compose stop`: SIGTERM, a 10s grace
period, then SIGKILL (docs/239). The bracket used to close *before* anything
knew whether the install would do any work, so a reinstall whose marker still
matched paid a full ~11s teardown of every `dependsOnInstall` service and then
skipped the install in milliseconds. Under the self-sustaining writer above that
was the entire cost of the loop — the preview died every 30s and the install
never once ran.

So the bracket now hangs off the worker's own `POST /install` answer.
`runInstall` takes an `onWorkerDecision` hook that fires once, the moment the
worker replies and before the outcome is known: `"skipped"` when the
content-keyed marker matched and no command will run, `"started"` when one will.
`reinstallForDepChange` opens the gate on `"started"` and on nothing else.

**Why the decision is not taken beforehand.** A probe against the marker was the
obvious shape and is wrong here: it answers a question about a moment that has
already passed. This bug's own repository rewrites its lockfile continuously, so
between the probe and the POST the answer can change and the install would run
unbracketed — a TOCTOU window that then needs a reconciliation path, which needs
its own tests, none of which exist if the decision comes from the call that
starts the install. Reading the answer instead of predicting it also costs
nothing: the teardown is asynchronous and already overlaps the install commands,
so the hold lands a round trip later than it used to and no earlier than the
install's first write.

Three properties keep the change contained:

- **The no-op path still runs the install.** Only the bracket is conditional.
  The skip branch inside `runInstall` is what clears a recorded `DependencyGap`
  — a matching content-keyed marker is positive evidence the tree fits — and
  what reports `install_status: skipped`.
- **It fails closed.** The hook does not fire on the join, dispose or transport
  paths, where no decision was observed. A `runInstall` that returns `ok: false`,
  or throws, therefore opens and closes the gate anyway, so the failure still
  latches `dependsOnInstall` services to `error` and still records the
  `DependencyGap` (nikzlabs/shipit#2429). "Nothing started" is never inferred
  from silence.
- **A gate already latched by an earlier failure is repaired, not inherited.**
  `_installFailed` is cleared only by a false→true transition, and the docs/286
  watchdog deliberately refuses to recover a gate it can see failed — so
  "no install ran, therefore no transition" would strand those services in
  `error` for the rest of the session, with nothing left that could release them.
  `reinstallForDepChange` reads `ServiceManager.installGateFailed` before
  anything can clear it, and brackets a skipped install when it is set.

  The repair takes **positive evidence**, on the same rule #2429 applies to
  `clearDependencyGap`: a marker skip, or an install that ran and succeeded —
  never an `unverified` completion. Those are synthesized from having observed
  nothing (a dispose, a reconnect resync that found no last result) and resolve
  `ok: true` by default; restarting gated services on one would be a repair
  justified by a value that means *we cannot tell*.

- **Opening the gate is ownership, not a request.** `setInstallRunning` ignores
  a same-value call, so it reports whether it actually transitioned. A repair
  that lands while a `setupServiceManager` install already holds the gate
  changes nothing and must not make the reinstall close someone else's bracket
  mid-install.

#### Two limits this deliberately does not close

- **A `POST /install` whose response is lost.** The worker spawns the first
  command before it replies, so an accepted install whose response never arrives
  runs unbracketed until the POST times out. Before this change the gate was
  held for that window. Closing it properly needs a two-phase
  accept-then-start handshake between orchestrator and worker, which is a larger
  change than this bug warrants; the state still converges, because the timeout
  returns `ok: false` and the failure bracket then latches the services. Named
  here so the next reader finds a decision rather than an oversight.
- **An `unverified` completion closes an OPEN bracket as successful.** Where
  this call owns the bracket and the completion is synthesized,
  `failed: !res.ok` reads `ok: true` and starts the gated services. That is
  pre-existing behaviour, identical before and after this change, and is left
  alone deliberately: latching those services to `error` instead would put them
  somewhere the watchdog will not recover them from, on equally weak evidence.

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
follows evaluates the *incoming* config.

**The call sites are enumerated from `restoreLfsAfterTreeRewrite`**, which
nikzlabs/shipit#2349 placed at every orchestrator-side worktree rewrite for the
same structural reason (a rewrite the orchestrator's git performs). Every one of
those that targets a *live session's own* workspace calls this too:

| Rewrite | Where |
|---|---|
| Sync/rebase (clean + conflicts-resolved) | `services/rebase-driver.ts` |
| Rebase abort | `api-routes-git.ts` |
| Rollback (HTTP) | `api-routes-git.ts` |
| Rewind (WS — the chat-level rollback) | `ws-handlers/rollback-handlers.ts` |
| Git pull | `api-routes-git.ts` |
| Merge a sibling session's branch | `api-routes-git.ts` |
| `shipit branch reset-to-base` | `api-routes-git.ts` |
| Post-merge pre-turn auto-reset | `pre-turn-reset-hook.ts` |
| `shipit release prepare` (own clone only) | `api-routes-github.ts` |

The two deliberate exclusions are `services/child-sessions.ts` (pinning a
*new* workspace — no live runner, and session setup installs it from scratch)
and a release prepare whose `resolvePrTarget` sent it at a `--repo`/`--cwd`
clone that is not this session's.

**The pre-turn-reset call site has a timing cost worth naming.** The reinstall is
asynchronous and the turn starts as soon as the hook returns, so the agent's
first commands can overlap the install window — gated services are held down,
and an immediate `npm run dev` can collide with npm writing `node_modules`. The
file-watcher path has the same shape whenever an agent edit triggers a
reinstall; what is different here is that no human pause separates the trigger
from the agent's first command. Awaiting instead was rejected: an install is
minutes on a cold tree, and blocking a user's turn on one is a much larger
change than the bug warrants. The overlap is recoverable and announces itself
(`install_status` / `install_log`, and the services return when it lands); a
silently stale `node_modules` is neither.

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

### Not re-running is a choice; not saying so was the bug

The skip above and a re-install that FAILS have the same consequence and had the
same reporting: none. Both leave the installed tree out of step with the
checkout, and #2429's whole cost was diagnosis, not repair — `npm ci` by hand
fixed it in seconds. The symptom is specifically resistant to being read
correctly: the service reports `running`, the error reads like a code fault
("does the file exist?"), and a restart does not help because the compose guard
is `[ -d node_modules ] || npm ci` and the directory exists.

So both paths record a `DependencyGap` on the runner
(`dependency-staleness.ts`) instead of returning quietly, and it is reported on
the two surfaces the reporter was actually looking at:

- **The transcript** — a persisted `[System]` warn notice, wired in
  `runner-registry-factory.ts` via `onDependenciesUnverified`. Persisted rather
  than emitted because the failure is met LATER: a notice that vanished on
  reload would be gone at the moment it is needed.
- **`shipit service list` / `GET /api/sessions/:id/services`** — a `dependencies`
  field riding alongside the list, the same shape and for the same reason as
  planning#382's `failure`. A service row cannot explain a failure whose cause is
  that the tree moved under it.

Three properties are load-bearing. The **gap is recorded before the notice is
emitted**, and the emit is contained — the hook reaches SQLite and the viewer
transports, and losing the state to a failure there would restore the silence
being removed. The **rewrite label rides through `onWorkspaceRewritten`**, so the
report names what moved the tree rather than being a fact with no cause; it is
*consumed* when an install starts, so a later watcher-driven failure cannot
inherit a rewrite it had nothing to do with. And the gap is **cleared only on
positive evidence** — an install that ran and succeeded, or a content-keyed
marker skip. Not the "worker restarted, we cannot tell" resync, which
synthesizes a completion from no evidence at all.

A **failed** install already latches `dependsOnInstall` services to `error`, which
is the loud half. It is still reported here because that covers only gated
services and never names the tree movement as the cause — which is the fact the
person reading the failure is missing.

The notice is deduped on `(reason, rewrite)`, not on reason alone. Deduping on
reason would mean a rollback days after the first notice is silent — the same
class of failure this removes — and `pre-turn-reset`, the one label that could
repeat on its own, fires once per merged branch rather than once per turn.

Auto-reinstalling the non-keyable case instead was rejected: its `null` deps hash
can never match the marker, so every rewrite would mean a full codegen/build from
scratch. Deferring is defensible; the notice is what makes it honest, and the
`agent.install-inputs` remedy it names is how a project opts into the automatic
path for good.

### Saying it at setup, before anything has failed

Everything above reports *after* a rewrite. The condition itself — an
`agent.install` that resolves no dependency-input set — is knowable at session
setup, and until it was reported there, a repository only ever learned of it
from the failure: mid-debug on a `Failed to resolve import` that reads like a
code fault. The production case (`nikzlabs/requirements`: a build step in
`agent.install`, `dist` in `dep-dirs`) was configured the way the pre-#2491 docs
recommended, so it was not a misconfiguration its author could have avoided.

So `setupServiceManager` evaluates it where it already resolves the input set,
and `applyShipitConfigChange` re-evaluates on every `shipit.yaml` change —
deliberately *outside* the `agent.install` delta, because the remedy the notice
names (`agent.install-inputs`) leaves the command list untouched, and a check
inside that delta would keep reporting a state the user has just fixed.

Three choices are load-bearing, and each is a deliberate *non*-duplication of
the gap notice above:

- **The diagnostics panel, not the transcript and not the prompt.** This is a
  configuration observation, not an incident — the same class as the ignored
  `agent.memory` / `cpu` / `pids` fields the panel already reports. The agent's
  channel for the failure case is the gap prefix, and a session that hits both
  must not read two paragraphs that sound the same. The notice therefore opens
  by saying nothing is broken, and never borrows the gap notice's phrasing.
- **A record beside the install marker** (`.install-not-content-keyed`) so the
  panel reads a state
  detected once at setup, and the operator log line fires once per *distinct*
  command list rather than once per container recreate. The record is cleared
  the moment the config resolves an input set again, so it cannot outlive the
  condition.
- **Reporting only.** No auto-reinstall, no change to
  `notifyWorkspaceRewritten`'s decision, no change to the marker gate. Whether
  the non-keyable case should reinstall itself is a separate, undecided call.

The remedy is not one answer, so the notice points at the shipped decision rule
(`shipit-docs/shipit-yaml.md` → *When `install-inputs` is the answer, and when it
is a trap*) rather than restating it: `install-inputs` is right for a step whose
inputs are enumerable and a **trap** for a whole-source-tree build, where the
step belongs in the service `command:` instead.

## Key files

- `src/server/orchestrator/install-content-key.ts` — the setup-time detection:
  the `contentKeyingIsOff` predicate, the once-per-command-list record, and the
  panel's notice text.
- `src/server/orchestrator/services/diagnostics.ts` — `installContentKeyOff` on
  the diagnostics payload; `src/client/components/SessionDiagnosticsPanel.tsx`
  renders it under *Parsed shipit.yaml*.
- `src/server/orchestrator/container-session-runner.ts` — `setDepReinstallInputs`,
  `isDepInputChange`, `maybeReinstallForDepChange` (throttle), `reinstallForDepChange`
  (the bracket), `runInstall`'s `onWorkerDecision` hook (planning#2503); the
  `file_changes` handler calls into them; dispose clears the timer.
  `notifyWorkspaceRewritten` is the #2429 entry point for an orchestrator-side rewrite.
- `src/server/orchestrator/service-manager.ts` — `installGateFailed`, the
  latched-failure reader a caller must consult before skipping the bracket.
- `src/server/orchestrator/workspace-rewrite.ts` — `onWorkspaceRewritten`, the shared
  "the orchestrator rewrote this tree" call (config re-read + dependency re-check),
  passing the caller label through so a report can name the rewrite.
- `src/server/orchestrator/dependency-staleness.ts` — the `DependencyGap` type and
  its two renderings (transcript notice + one-line service-list summary). Pure text.
- `src/server/orchestrator/api-routes-preview.ts`,
  `src/server/session/agent-shim/shipit-service.ts` — the `dependencies` field
  alongside the service list, and its rendering for the agent.
- `src/server/orchestrator/services/rebase-driver.ts`,
  `src/server/orchestrator/api-routes-git.ts` (rebase-abort, rollback, pull,
  session merge, `reset-to-base`), `src/server/orchestrator/api-routes-github.ts`
  (`release prepare`), `src/server/orchestrator/ws-handlers/rollback-handlers.ts`
  (rewind), `src/server/orchestrator/pre-turn-reset-hook.ts` — its callers.
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
  on the watcher path and on the #2429 orchestrator-rewrite path alike. The
  rewrite path additionally reports it (above); the watcher path does not, because
  there the person who changed the file is the one reading the transcript.
- **No `agent.install` at all**: nothing is reported, on the rewrite path or at
  setup. There is no dependency step to be out of step with the tree, so a
  warning would be about a problem the session cannot have.
- **`install-inputs` declared but content-keying still off**: an explicit empty
  list opts out on purpose (`deps-hash.ts`), so the setup notice stays quiet —
  the choice was made deliberately, which is the thing the notice exists to ask
  for.
- **An untrusted remote**: nothing is reported until the repo is trusted. The
  docs/178 gate returns before the detection, so the panel can show a
  non-keyable `agent.install` (read live from `shipit.yaml`) with no
  accompanying row. Left as-is deliberately: the gate's whole point is that
  nothing repo-declared is acted on first, and the session is unusable until
  trust is granted anyway.
- **A recognized but input-free install** (`uv venv`, `python3 -m venv`): the
  setup notice fires. The commands are recognized, but the union of their inputs
  is empty, so the deps hash is `null` and both halves are off exactly as for an
  unrecognized command.
- **A rewrite that changes both `shipit.yaml` and the lockfile**: the config
  re-read may already have requested a reinstall (a changed `agent.install`), and
  the dependency check then asks again. The 30s cooldown coalesces the two into
  one trailing pass rather than stacking installs.

## Out of scope

- Parsing an import-resolve failure out of a service's log to attach the hint to
  the error itself. The `Dependencies:` line on the service list is the fact; a
  log-scraper for every ecosystem's phrasing is a different feature.
- A client-side rendering of the gap in the Preview/services UI. The persisted
  transcript notice is the human surface; the service list is the agent's.
- Sharing `node_modules` into non-overlay sessions (repo-backed sessions already
  share the overlay dep store with Compose services — docs/183 Phase 5).

## Verification

- `npm run typecheck`, `npm run lint:dev`, and the co-located unit test
  (4 cases) pass in-session.
- Integration coverage (CI-run; integration tests OOM a session container):
  extend the install-gate test so a `file_changes` event naming
  `package-lock.json` triggers `runInstall` + the gated-service hold→restart,
  and an unrelated path does not.
