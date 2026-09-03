---
issue: planning#501
title: A warm session's preview is already running — design
description: Warm the ServiceManager, not just the container — the runner path already adopts one, so the handoff exists.
---

# A warm session's preview is already running — design

Implements [`requirements.md`](./requirements.md). Requirements are cited as
`(req N)`.

## The shape of the fix

The warm pool builds a standby container and pre-runs `agent.install` on it
(`warm-pool-manager.ts`, the `createStandby(...).then(...)` block). It stops
there. The Compose stack is built by `setupServiceManager`, which needs a
*runner*, and a runner is only created at activation
(`runner-registry-factory.ts` → `_onRunnerCreated`).

The fix is to give the warm session a **ServiceManager** as well as a container,
and to let the existing activation path pick it up (req 1).

**The handoff already exists and does not need inventing.** `setupServiceManager`
opens with `const existing = serviceManagers.get(runner.sessionId)` and, when it
finds one, calls `adoptExistingServiceManager` and returns
(verified at `service-manager-setup.ts:863-891`). That branch was written for
docs/127's agent restart — a compose stack that outlived its runner, re-attached
to a fresh one. A pre-started warm stack is the same object in the same state,
reached by the same key. So warming registers its manager in `serviceManagers`
under the warm session's id, and activation adopts it with no new branch.

## What warming does

Extend the existing `createStandby(...).then(...)` continuation, after
`runPreInstall` resolves:

1. Build a `ServiceManager` for the warm session and register it in
   `serviceManagers`.
2. `mgr.setInstallRunning(false)` — the pre-install has already finished, so the
   install gate is open and the auto-preview services are not held.
3. `await mgr.start()`.

The install must have finished first: `start()` partitions auto services on the
gate, and a gate closed at that moment holds them until something reopens it.
Sequencing it after `runPreInstall` is what makes the pre-started stack the
*started* one rather than a held one.

### The construction must be shared, not copied

`setupServiceManager` builds the manager with a dozen collaborators — the
secrets loader, the containment functions, the log store, the network-mode
hook, the overlay dep-dirs. A second construction site that drifts from the
first is how docs/148 silently regressed for months (a `withStandby` opt-in that
exactly one caller forgot). So: **extract the construction half of
`setupServiceManager` into one function both paths call.** The warm path passes
no runner; the collaborators that need one (the `stack_error` listener, the
runner's `setServiceManager`) are wired by the adopting path at activation,
which is where they already get wired for docs/127.

### Trust (req 2)

The pre-start sits **inside** the same `repoStore.isTrusted(repoUrl)` branch that
already gates `runPreInstall` (`warm-pool-manager.ts:308`). Starting a dev
server runs the repository's own `command:`/`build:`, which is exactly the
execution docs/178 defers. An untrusted remote gets a standby container and
nothing else, as today.

### Recency (reqs 8, 9)

Gate the pre-start on `repo.lastUsedAt` being inside **7 days**
(`WARM_PREVIEW_RECENCY_DAYS`). The stamp already exists and is maintained on
every claim (`claim-session.ts` — `deps.repoStore.touch(url)`), so this is a
read, not new bookkeeping. The warm *session* itself is unchanged: every ready
repo still gets one. Only the preview is limited, because only the preview has a
standing cost.

**Why a cutoff does not punish a break (req 9).** Two properties of where the
gate sits, both of which have to stay true if the number is ever changed:

- **It is evaluated when ShipIt WARMS, not when the user claims.** Yesterday's
  claim re-warmed the next session and pre-started its preview; that stack is
  what the morning's claim adopts. Nothing about it is decided at the moment the
  user arrives.
- **Every claim re-stamps `lastUsedAt`.** An absence longer than the cutoff
  therefore costs exactly ONE cold preview: the first session back warms the
  next one, and the repo is recent again. The failure mode degrades by one
  session, not by a mode change.

## The warm tier must heal itself (reqs 10, 11)

The cutoff is not what threatens the morning. This is, and it is broken today,
before this feature exists: **nothing ever checks that a standby is still
alive.** Three gaps compose into one permanent failure.

1. **No liveness monitoring.** `createMissingContainerReconciler` walks
   `runnerRegistry.ids()` and skips standbys explicitly
   (`app-lifecycle.ts:1025`) — and a standby has no runner to walk in the first
   place. A real session is watched through its worker's `/events` stream; a
   standby has no stream and no watcher.
2. **The boot sweep validates the wrong thing.** It checks that the workspace
   clone exists and, when it does, logs `warm session … validated (clone
   exists)` and moves on (`startup-tasks.ts:487-500`). A repo whose container
   died hours ago passes that check.
3. **Nothing can re-warm it afterwards.** `warmSessionForRepo` declines while
   the warm session ROW exists (`warm-pool-manager.ts:86-89`), and it is called
   only from the boot re-warm, repo add, repo trust, the claim re-warm and
   graduation. **There is no periodic sweep.**

So the state is absorbing: a repo whose standby dies keeps a warm session that
can never be repaired, and every later claim silently pays the full cold cost —
container create, `agent.install`, `compose up`, dev-server boot — while still
being reported as a warm hit (req 11).

The cause does not matter, which is the point. A container that exits, an OOM
inside the pre-install (`npm install` in a memory-limited cgroup), a Docker
daemon restart — the agent container carries no `RestartPolicy`
(`compose-cli.ts:297`), so it does not come back — or any external cleanup all
land in the same absorbing state. Memory-budget reclaim (`idle-enforcer.ts:207`)
is one entry to it, not the mechanism, and an instance that never reaches its
budget still gets there by every other route.

With this feature the same night also takes the pre-started preview, so the
benefit would disappear exactly when the user most expects it.

**Fix (shipped): a periodic warm sweep that compares state.** Every five
minutes, for each ready repo: if its warm session has no *running* container and
there is memory headroom (`isUnderEvictionPressure` is false), rebuild the
standby and re-run the pre-install. When the preview work lands, the same repair
pre-starts the stack — it goes through one shared entry point,
`ensureStandbyForWarmSession`, which the warm flow and the sweep both call so
the two cannot drift (`warm-tier-sweep.ts`, `warm-pool-manager.ts`).

The liveness question is asked of **Docker**, not of the tracking map
(`isTrackedContainerRunning`). The map is fed by container events and by a
health monitor that standbys are outside of, so trusting it would make the sweep
blind to the exact failure it exists to catch. A `undefined` answer — the daemon
could not say — is never read as death.

"Running" is the check the boot sweep is missing — `containerManager.get(id)`
with `status === "running"`, the same test the runner factory applies at claim
time (`app-lifecycle.ts:777`). Asking it periodically instead of only at the
claim is the whole fix; the boot sweep should ask it too, alongside its clone
check.

Deliberately **not** keyed on the pressure-release transition, though
`startup-monitors.ts` already computes one. A transition is observed once, by
one observer; a sweep that missed it — because it started later, or because the
process restarted mid-window — never heals. Comparing "what should exist" with
"what does exist" gives the same answer however the system got there.

The sweep is also what makes req 4 safe to be aggressive about: tier 0 can drop
warm previews the moment memory is tight precisely because they come back on
their own when it is not.

7 days is the smallest window that clears a long weekend plus a public holiday
with room to spare. It sits between the two windows that already exist: a repo
untouched for 30 days loses its bare cache to the steady-state janitor
(`DEFAULT_CACHE_DAYS`, `steady-state-reclaim.ts`) and cannot be warmed at all,
so the gate is only ever choosing among repos that are still cached.

The number is a coarse pre-filter, not the cost control. The real bound is req
4: a warm preview is the first thing the idle enforcer stops under memory
pressure, so a generous cutoff cannot starve a real session.

### Off the critical path (req 3)

The continuation is already fire-and-forget from the warm flow, and nothing
awaits it. `claim-session`'s re-warm is likewise not awaited (docs/144). No
change needed — but the pre-start must not be added to any awaited path.

## What activation does

Nothing new. `setupServiceManager` finds the manager and adopts it. Two things
have to be true, and both need checking rather than assuming:

- **Adoption must not restart a healthy stack.** `adoptExistingServiceManager`
  reconciles when the compose config changed; a warm stack was started from the
  same workspace and the same file, so the reconcile must resolve to "unchanged"
  and leave the containers alone. If it does not, the whole saving is spent.
- **The re-armed install gate must not re-hold the running services.** On a warm
  claim the install marker is present, so `runner.runInstall` short-circuits and
  the gate opens in milliseconds. But `setInstallRunning(false → true → false)`
  around it drives `holdGatedServicesForReinstall`, which issues `compose stop`
  on exactly the services we pre-started. The adopt path must skip the re-hold
  when the install is a marker-skip. This is the one place the design can
  silently undo itself, and it is where the tests should be sharpest.

## The claim's rebase (req 5)

`claim-session` brings the clone up to fresh `origin/main` before the user opens
the session. The stack keeps running: the compose services bind-mount the same
workspace directory, so the dev server's own file watcher sees the new files —
the same mechanism that already serves every agent edit and every `git reset` a
turn performs. No restart, no probe.

The accepted cost, stated plainly: for the moment between the fetch and the
recompile the preview serves the pre-fetch build. A dependency change is
different in kind and is already handled — the dep-reinstall path re-runs
install and re-holds the gated services (docs/239).

## Memory (req 4)

The idle enforcer's **tier 0** already destroys standby containers first, ahead
of every real session (`idle-enforcer.ts:200-218`), which is exactly the
ordering req 4 asks for. Two adjustments:

- Tier 0 must **stop the warm ServiceManager** before destroying the container.
  Today a standby has no compose stack, so tier 0 destroys the agent container
  alone; with this feature it would leave the preview containers running with no
  manager and no session.
- The bytes it credits must include the stack. `bySession` already separates
  `agentBytes` from `serviceBytes` (`docker-memory.ts:89-92`), and tier 0
  subtracts only `agentBytes` — which would under-count the reclaim and evict a
  second victim for bytes already coming back.

Creation stays gated on `isUnderEvictionPressure`, as the standby already is.

## Restart (req 6)

`retireWarmSessions` deletes every warm row and `reapStandbyContainers` removes
every unclaimed `shipit-standby=true` container. **Neither covers the compose
containers**: the standby label is on the agent container, and the orphan sweep
filters on the agent-container labels only (verified at
`session-container.ts:903`, `labelFilters`). A pre-started preview would
therefore survive a deploy as a running container with no session — serving the
old image and the old code, which is the whole reason standbys are retired.

Retirement must stop each warm session's stack (or sweep by
`shipit-parent-session` for sessions no longer tracked) before the container
sweep runs.

## Measurement (req 7 — shipped)

The `[timing]` lines are already in place, so this design can be judged against
numbers rather than argument:

| Line | Where | What it bounds |
|---|---|---|
| `container.acquire` | `app-lifecycle.ts` | standby hit vs standby-abandoned vs cold create |
| `install-gate` | `service-manager.ts` | how much of "Starting…" was `agent.install` |
| `compose.up` | `compose-cli.ts` | the `up` itself, split into image and container work |
| `preview.first-connect` | `preview-timing.ts` | the dev server's own boot — the part this feature removes |

`preview.first-connect` is the number this feature is trying to move: on a warm
hit it should stop being paid at all, because the first request arrives at a
server that has been up since before the session was claimed.

## Key files

- `src/server/orchestrator/warm-pool-manager.ts` — where the pre-start is added.
- `src/server/orchestrator/service-manager-setup.ts` — construction to extract;
  `adoptExistingServiceManager` is the handoff.
- `src/server/orchestrator/idle-enforcer.ts` — tier 0.
- `src/server/orchestrator/startup-tasks.ts` — warm-tier retirement.
- `src/server/orchestrator/preview-timing.ts` — the measurement.
