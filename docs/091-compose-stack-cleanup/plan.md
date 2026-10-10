---
issue: planning#587
---

# Compose Stack Cleanup

Clean up orphaned Docker Compose stacks (user service containers, networks, volumes) on orchestrator startup and in shell launch scripts.

## Problem

On orchestrator startup, `cleanupOrphans()` only removes **agent containers** (labeled `shipit-session=true`). It does not touch:

1. **Compose service containers** — labeled `shipit-parent-session={sessionId}` but not `shipit-session=true`. These are user services (postgres, redis, etc.) spawned by `ServiceManager`.
2. **Compose networks** — per-session networks named `shipit-session-{sessionId}`.
3. **Compose volumes** — volumes created by compose stacks, also labeled `shipit-parent-session`.

When the orchestrator crashes or restarts, these resources are orphaned. `ServiceManager.killStaleContainers()` only runs per-session when that session's compose stack is re-started — it doesn't help sessions that are never re-activated.

The shell scripts (`dev.sh`, `prod.sh`, `deploy.sh`) kill agent containers by the `shipit-stack` label and prune networks, but compose containers use a different label (`shipit-parent-session`) and are missed entirely.

## Design

### Orchestrator startup cleanup

Add `cleanupOrphanComposeResources()` in `container-discovery.ts` (where `cleanupOrphanContainers` lives):

```typescript
export async function cleanupOrphanComposeResources(
  docker: Docker,
  activeSessionIds: Set<string>,
): Promise<number>
```

Logic:
1. `docker.listContainers({ all: true, filters: { label: ["shipit-parent-session"] } })` — finds all compose-managed containers.
2. For each container, read the `shipit-parent-session` label value (the session ID).
3. If the session ID is **not** in `activeSessionIds`, call `cleanupSessionDockerResources(docker, sessionId)` from `container-lifecycle.ts` — this already handles stopping/removing containers, networks, and volumes for a given session.
4. Deduplicate: collect orphaned session IDs first, then call `cleanupSessionDockerResources` once per session (not once per container).
5. Return total count of removed containers for logging.

Call site in `app-lifecycle.ts`, after the existing orphan cleanup:

```typescript
const orphans = await containerManager.cleanupOrphans(activeIds);
if (orphans > 0) console.log(`[server] Cleaned up ${orphans} orphan container(s)`);

const composeOrphans = await cleanupOrphanComposeResources(docker, activeIds);
if (composeOrphans > 0) console.log(`[server] Cleaned up ${composeOrphans} orphan compose resource(s)`);
```

### Shell script cleanup

Today, compose containers only carry `shipit-parent-session={sessionId}` — they don't have the `shipit-stack` label that agent containers use to distinguish dev vs prod. This means we can't safely filter by stack when both run on the same Docker host.

**Step 1: Add `shipit-stack` label to compose containers.**

Thread the stack name (`process.env.DOCKER_STACK`) through to the compose override generator:

- Add `stackName?: string` to `ComposeOverrideOptions`.
- Pass it from `app-lifecycle.ts` (where `process.env.DOCKER_STACK` is already read for `SessionContainerManager`).
- In `generateComposeOverride()`, add `"shipit-stack": opts.stackName` to each service's labels (when set).

**Step 2: Filter by stack in shell scripts.**

```bash
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit-dev") 2>/dev/null || true
```

This mirrors the existing agent container cleanup line and is safe when dev and prod share a Docker host — each script only kills its own stack's containers.

For `deploy.sh` (Hetzner), the stack label is `shipit` (no suffix).

### Why not `docker compose down`?

`docker compose down` requires the original compose files and project name. After a crash, the workspace directory may not be intact. Label-based cleanup is more robust — it works purely through the Docker API with no filesystem state.

### Every sweep is stack-scoped (planning#584)

Two ShipIt instances on one Docker daemon each hold a session store that knows nothing of the other's sessions, so an unscoped "not in my store ⇒ orphan" sweep destroys the other instance's compose services, session networks, volumes, warm pool and in-flight plugin installs at every boot. Every boot sweep that judges liveness from the session store therefore adds the `shipit-stack=<DOCKER_STACK>` filter that `cleanupOrphanContainers` always had (`stack-label.ts` holds the label and the filter), and keeps it through the teardown it triggers, because a restored backup gives two instances the same session ids:

- `reapStandbyContainers` and `cleanupOrphanComposeResources` (`container-discovery.ts`); the latter passes the filter into `cleanupSessionDockerResources`.
- `reapSurvivingComposeStacks` (`compose-stack-reaper.ts`), discovery and `downComposeStackByProject` both.
- The startup janitor's volume and network sweeps (`startup-janitor.ts`, `--filter label=shipit-stack=…` on `docker volume ls` / `docker network ls`) and its plugin sweep (`reapOrphanPluginInstalls` in `plugin-install.ts`).
- The stop and launch scripts (`deployment/vps/stop.sh`, `deployment/local/lib.sh`, `docker/local/{dev,prod}.sh`): one `docker rm -f` over the stack label, and `docker network rm` over the stack's labelled networks instead of a host-wide `docker network prune`.

The egress-sidecar reaper (`egress-orphan-reaper.ts`) stays host-wide on purpose: it judges from the sidecar's actual parent container, not from the session store, so it cannot mistake another instance's live session for an orphan.

The filter is positive: a resource with **no** stack label is treated as foreign, not as ours. Ownership fails closed — a dangling volume may be another instance's stopped database — and an instance that runs with no `DOCKER_STACK` applies no filter, so it keeps the host-wide sweeps it always had.

For a scoped sweep to see its own resources, everything ShipIt creates has to carry the label. Session workers, standbys, egress sidecars, session networks and dep-dir overlays always did (`baseLabels()`); the compose service containers have since this feature landed. planning#584 added it to the rest: the Compose-created session network and user-named volumes (`compose-generator.ts`), plugin install/CLI/netns containers with their sidecars and plugin overlay volumes (`plugin-install.ts`, `plugin-cli-run.ts`, `plugin-egress.ts`, `plugin-overlay.ts`), and everything a session creates through the Docker proxy (`ownershipLabels()` in `docker-proxy-helpers.ts`). **Consequence:** a Compose network, user-named volume, plugin resource or proxy-created resource that already existed when planning#584 shipped has no label, so the boot sweeps and stop scripts leave it alone from then on — including this instance's own already-orphaned ones. That is deliberate: the alternative is guessing ownership. The per-session paths are unaffected, since they select by session id or Compose project rather than by stack: `destroy` and archive (`cleanupSessionDockerResources`, `pruneSessionVolumes`) and generation deletion for plugin overlays (`plugin-leases.ts`).

#### A live session's network is not litter — labelling it deadlocked `compose up`

The consequence above reads as "unlabelled leftovers are merely never reclaimed". For the Compose **session network** of a session that is still alive, it was worse than that. Compose hashes the network's definition into `com.docker.compose.config-hash`, so adding the label changed the hash for networks created before the deploy: the next `up` decided the network must be recreated, and its `docker network rm` failed on the endpoints **ShipIt** attaches out-of-band — the session's agent container (`container-lifecycle.ts`) and the orchestrator, which joins every session network to route previews (`joinSessionNetwork`). Compose owns neither, so it could never clear them; `up` exited 1 after the build with no service container ever created, deterministically and forever. Two production sessions needed an operator to disconnect the endpoints by hand. The orphan-network sweep cannot help here either, and not only because the network is unlabelled: the session is in the store, so it is not an orphan by any definition.

The recovery therefore belongs to the session's own `up`, beside the container-name-conflict recovery: `ComposeCli.recreateSessionNetwork` (`compose-cli.ts`) parses the network out of the daemon error and — only for `shipit-session-<this session's id>` — disconnects exactly the two endpoints ShipIt owns, removes the network, and retries the `up` once. Any later change to the network definition — another label, `internal`, a driver option — takes the same path instead of stranding every pre-existing session. Four properties are load-bearing:

- **Endpoints Compose owns stay attached.** Compose removes those itself and recovers unaided; force-disconnecting a user's service would be ShipIt breaking a container it does not manage. So when the removal still fails, something ShipIt does not own holds the network, and the original `up` failure is what gets reported.
- **Severing is always paired with re-attaching, inside `ComposeCli`.** The recovery hands the endpoints back through `rejoinSessionNetwork` on *every* exit — after the retry whether it succeeded or failed, and as soon as a removal fails after the severing achieved nothing. Leaving that to the caller does not work: `refreshSecrets` reaches `compose up` without ever calling `joinSessionNetwork`, and the poller's `healSessionNetwork` re-attaches only the agent, never the orchestrator. A session left running with the orchestrator off its network reports healthy services behind an unreachable preview. For the same reason the two endpoints are now joined **independently** (`joinSessionNetworkEndpoints`): a failing agent join used to skip the orchestrator's, and nothing else ever attaches the orchestrator.
- **`ComposeCli` removes the network itself, and tries twice.** Deferring the removal to the retried `up` would widen the window between the disconnect and the removal from one Docker call to a whole build, and the poller's network heal re-attaches the agent inside it — turning the recovery back into the failure it is fixing. Removing it here narrows that window; a second disconnect-and-remove pass closes it, for far less machinery than serialising `ComposeCli` against the poller.
- **Detection is anchored to the daemon's error record on a non-build line.** The rejected `up`'s message carries the tail of its whole stderr, build output included, so a matcher that accepts the bare phrase — or even a complete daemon error quoted by a `RUN` step — lets build output trigger a destructive recovery against a healthy network.

#### A stopped stack's network is ShipIt's to remove

`compose down` does not remove a network that has any container attached: it reports `Resource is still in use` and exits 0 (`removeNetwork` in Compose's `pkg/compose/down.go`, read at v5.5.1, the version the images pin). The orchestrator's own endpoint is such a container, and Compose can never clear it. So every stack stop left `shipit-session-<id>` in place with the orchestrator alone attached, and each one held a network of Docker's default address pool. `cleanupSessionDockerResources` did not take it either: it selects by `shipit-parent-session`, and the Compose-created network carries only the stack label and Compose's own. A host with the daemon's default pools — about 30 networks — ran out, and new previews failed with `all predefined address pools have been fully subnetted` (found 2026-10-10).

`releaseSessionNetwork` (`session-network-release.ts`) is the one removal. It leaves the network when any container other than the orchestrator names it, and otherwise detaches the orchestrator and removes the network. Five properties are load-bearing:

- **A container in any state keeps the network.** Docker removes a network that a created or stopped container still names, and that container can then never start. So the release lists the containers that name the network in every state (`docker ps -a --filter network=…`), not only the running ones that `docker network inspect` shows. A stack that Compose has created and not started yet, or a service that crashed, is enough to keep it.
- **A registered `ServiceManager` owns the network, with or without containers** (`stackOwned`, read as `serviceManagers.has(sessionId)`). The release is for a stack that is *stopped*. A live manager can start a service outside the stack queue at any moment (`startService`, `restartService`, a retry), and `refreshSecrets` runs `up` without joining the orchestrator again — so taking an empty network from a live manager breaks the start that is in flight, or leaves a preview that nothing can route to. Every stop path that ends a stack takes the manager out of `serviceManagers` before it calls `stop`; the disk-tier escalation, which takes it out afterwards, runs `downComposeStackByProject` next. The paths that stop a manager and keep it (a containment change, a restart) keep the network too, and use it again.
- **It runs in the session's stack queue, and no teardown waits for it** (`releaseSessionNetworkQueued`). `up` finds the network before it creates its first container, and no listing shows that interval. A stop is not a stack operation and can outlast `awaitComposeStop` (15 s, and a `down` waits for each service's grace period), so a release at the end of the stop could remove the network under the start that came after it. As its own queued operation it lands behind that start, and reads the ownership there. A manager that registers later runs its first `up` — a queued `start`, in both places that build a manager — behind the release. It is not awaited, because a teardown must not wait for a build that is ahead of it in the queue.
- **Each Docker call has a time limit** (an abort signal). The stack queue has none of its own, and a daemon that never answers would hold every later start of the session.
- **Severing is paired with re-attaching**, as in the recovery above: when Docker refuses the removal after the orchestrator was detached, the orchestrator is put back, and a failure to do that is reported.

Three places ask for it, because a stack and its agent container stop on different paths and either can be the last to go:

- **`ServiceManager.stop`, after a successful `down`** — the stack stopped and the agent container was already gone: tier 2 of docs/284, a warm preview, an eviction. The second `down` that follows a late `up` (below) asks again.
- **The `container_destroyed` listener** (`bootstrap-managers.ts`) — the stack stopped while the agent was still attached. That is the order the idle enforcer's stop of a done session produces, and also a tier 1 teardown that tier 2 overtakes in the same pass. The listener asks after every `destroyContainer` of a tracked container; the ownership rule is what keeps a tier 1 preview's network, and the orchestrator on it. A container that goes another way — a failed creation, the boot orphan removal, a removal from outside ShipIt — raises no event, and its network waits for the boot sweep.
- **`downComposeStackByProject`**, for the stacks a previous orchestrator left — an orchestrator container that restarts in place re-attaches to every network it was on, and a plain removal fails on that. Its callers hold the stack queue, and no manager exists for such a stack.

Nothing needs the network between a stop and the next start: `up` creates it again, and the `start` that runs it ends in `joinSessionNetwork`.

#### A stop and a start that is already in flight

`ServiceManager.stop` is not a stack operation, and some starts are not either (`startService`, `restartService`, a retry, `refreshSecrets`). So a stop can run while a start of the same manager builds an image or runs `up`, and it neither waits for that start nor can it cancel it: the build and the `up` run in the confined helper, which has no cancel. A start that ended after the `down` left a stack that no manager owned, on a network that the release had removed or that the late `up` created again. Nothing routed to it, and it stayed until `reapSurvivingComposeStacks` at the next boot. Two rules close this, and each start is under exactly one of them:

- **A start that a stop overtook does not run `up`.** `stop()` counts its calls (`_stops`). A start reads the count when it begins, and `buildAndUp` compares it after the build, immediately before `up`. A count and not the `_disposed` flag: `start()` clears the flag, and the paths that stop a manager and start it again (a containment change, for example) must not let the older start run an `up` from files that it wrote under the older policy. Such a start ends quietly. `withUpInFlight` catches the refusal and resolves `false`, which says only that no `up` ran: it is `false` too when the user stopped the services during the resolve, and the caller then goes on and tells the network join that the network can be absent (`networkExpected`). So each of the six callers reads the count at its own entry and compares it again after `withUpInFlight`: when a `stop()` came, it runs none of its later steps and reports no error. That also ends a start that runs no `up` at all — in `start()`, every service can wait at the install gate — and a start whose `up` ended before the stop came. `start()` then sets its services back to "stopped", which the stop had set before the start set "starting".
- **A stop takes down what an `up` that was already running creates.** That `up` can be at an image pull, and creates its containers after the `down`. `stop()` reads the `up`s that still run immediately before its `down`, and when they have ended it runs `down` again as its own stack operation. Two conditions, read inside the queue, keep that second `down` from a stack that is in use again: the same manager has not started since, and no manager is registered for the session (`stackOwnedFn`, the ownership rule of the network release). A registered manager owns what the late `up` created, and its own stop takes it down. The stop does not wait for the second `down`, for the reason that `stopService` does not wait for a build. The second teardown is the first one again — a stop of each running service from the files of its start, so that a `pre_stop` hook runs, and then `down` — with two differences:

- **The first `down` keeps the start record when an `up` still runs.** `down` removes the containers that it listed when it began, so a late `up` can end during it; `ComposeStartRecord.clear` then forgets a start that has ended, and the second teardown could not find its files. So the second teardown clears the record, and a second teardown that does not run leaves the record to the manager that owns the stack.
- **Each of its two steps has a time limit, because it holds the stack queue** (`ComposeCli.bounded`). A hook is the project's own command, and one that never ends would otherwise hold every later start of the session. The limit is the longest stop grace period of the stack plus the margin that the install gate's teardown uses. At the limit the command's process tree is killed — `docker` and its Compose plugin both hold the pipes — and by force after a grace period (`killProcessTree`), and only then is the queue free. The orchestrator also closes its ends of the pipes, so that a process outside that tree cannot hold the command open after `docker` has gone. A kill of the command line tool does not undo what the daemon already accepted, and a hook that needs longer than the limit is cut. A stack that the limit leaves waits for the boot cleanup: `reapSurvivingComposeStacks`, or `cleanupOrphanComposeResources` when its session has left the store.

There is no await between the comparison and the `up`. So when a stop reads the running `up`s, every older start is in that set, or it finds the count changed before it runs one.

One overlap stays, and it is not a leak: when a manager is stopped and started again while an older `up` still runs, the older `up` and the new one run on the same project together, as two starts of one manager always could. The manager owns the result.

#### A start that waited, and a manager that lost the session

The two rules above are for a start that began before the stop. A start that begins after it is a different case, and nothing in the manager stops it: `start()` clears the manager's disposal and reads the new count. Such a start comes from an operation that took a manager and then waited — for the stack queue, for the plugin services, or for the worker of a new agent container, and a disposal resolves that last wait too (`whenWorkerReady`). When the manager was taken out of `serviceManagers` and stopped during the wait, the operation started it again, and no later stop came.

So each operation that waited reads the registry in the stack queue, immediately before its `start()` or `reconcile()` (`ownsStack` in `service-manager-setup.ts`): the first start in `setupServiceManager`, the two reconciles of `adoptExistingServiceManager`, the plugin round, and the config change. `preStartWarmPreview` had the same check already. A stop that comes after the check is a stop of a start in flight, which the rules above cover.

The check is at the call sites and not in `ServiceManager.start()`. The registry is the setup layer's fact, a manager that is built without one must still start, and a `start()` that does nothing would tell its caller that the stack is up.

An adoption with a containment change also resets the session network before its reconcile. It now does that only for a manager that still has the session: the reset removes the network with every endpoint on it, and by then the network can be that of another manager's stack. Nothing is lost, because each `start()` checks the mode of the network itself (`ensureSessionNetworkMode`).

A manager that a disposal keeps for the preview (docs/284) stays registered, so its reconcile still runs.

One order is not covered by the check: the disk-tier escalation (`tier-escalation.ts`) and the rescue of a container (`restartContainer`) stop a manager first and take it out afterwards, so an operation whose turn comes during that stop still starts it. In the rescue, the disposal that follows stops the manager again, and that stop finds the start in flight. In the escalation nothing stops the manager again: `downComposeStackByProject` runs next in the same queue and takes down the stack that the operation started, but the manager stays started and unregistered, and a retry of one of its services can run `up` after that. The escalation is for a session that has no runner, and the operations that the check guards come from a runner, so this needs an operation that still waits in the queue when the escalation comes.

The boot sweep's rule changed with it. A dangling session network was kept whenever its session was in the store, so a leak lasted as long as the session row. `sweepOrphanSessionNetworks` (`startup-janitor.ts`) now also takes the **Compose** network of a stored session that holds no runner, container, stack or restore in this process (`isSessionLive`). Only that network: Compose creates it under a `ServiceManager` that is already in `serviceManagers` (verified at `setupServiceManager` and `preStartWarmPreview`), so a start in flight reads as live. The Docker-access and egress networks are created before the container record exists (`createContainer`), so they keep the store-membership guard. The removal is `releaseSessionNetwork` again, because `dangling` means "no endpoint" and a stopped container that still names the network has none; without a Docker client to list containers with, a stored session keeps its network. The last liveness check and the removal run together in the session's stack queue, because a manager that registers after the removal was issued cannot call it back. The sweep is stack-scoped, and it reads two listings. The first is `dangling=true`, as before. The second has no `dangling` filter, and is only for the Compose network of a stored session that is not live: an orchestrator container that restarts in place — a Docker Desktop restart, a host reboot, a crash under a restart policy — is back on every network it had joined, so a network that a stopped stack left is not dangling then. For a stored session that is not evicted, `releaseSessionNetwork` decides in both cases, so its network stays when any other container names it, in any state. Nothing is taken from the second listing for a session that is not in the store, or that is evicted: such a network keeps the handling it had — the first listing and a plain `network rm` — and so goes when the orchestrator container is next recreated.

The pool is the other half. ShipIt asks for no subnet size, so each network takes one whole network of the default pools. `deployment/vps/setup.sh` widens the pool on a VPS. A local install has the daemon's default, so `warnIfAddressPoolIsSmall` (`docker-address-pool.ts`) reports it at startup, and the preview's error hint names where the setting is in Docker Desktop as well as on a Linux daemon.

### Edge case: active sessions with stale compose stacks

Sessions that still exist in the DB but whose compose stacks are orphaned (orchestrator restarted mid-session) are handled by the existing `ServiceManager.killStaleContainers()`, which runs at the start of `ServiceManager.start()` when the session is re-activated. No change needed.

## Key files

| File | Role |
|------|------|
| `src/server/orchestrator/compose-generator.ts` | Add `shipit-stack` label to compose override |
| `src/server/orchestrator/compose-cli.ts` | `up` recovery when a changed network definition meets ShipIt's own endpoints; `bounded()`, for commands that run in the stack queue |
| `src/server/orchestrator/session-network-release.ts` | `releaseSessionNetwork()` — removes a session network that only the orchestrator is attached to |
| `src/server/orchestrator/startup-janitor.ts` | Boot sweeps, including the session networks that a stopped stack left |
| `src/server/orchestrator/service-manager.ts` | `stop()`, and what it does about a start that is in flight |
| `src/server/orchestrator/service-manager-setup.ts` | `ownsStack()` — no start or reconcile for a manager that lost the session while it waited |
| `src/server/orchestrator/docker-address-pool.ts` | Startup warning for a default-sized address pool |
| `src/server/orchestrator/container-discovery.ts` | Add `cleanupOrphanComposeResources()` |
| `src/server/orchestrator/container-lifecycle.ts` | Existing `cleanupSessionDockerResources()` — reused, not modified |
| `src/server/orchestrator/app-lifecycle.ts` | Pass stack name to ServiceManager; call new cleanup function during startup |
| `docker/local/dev.sh` | Add compose container cleanup line |
| `docker/local/prod.sh` | Add compose container cleanup line |
| `deployment/hetzner/deploy.sh` | Add compose container cleanup line |
