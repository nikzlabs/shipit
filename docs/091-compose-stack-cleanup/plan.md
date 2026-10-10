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

- **`ServiceManager.stop`, after a successful `down`** — the stack stopped and the agent container was already gone: tier 2 of docs/284, a warm preview, an eviction.
- **The `container_destroyed` listener** (`bootstrap-managers.ts`) — the stack stopped while the agent was still attached. That is the order the idle enforcer's stop of a done session produces, and also a tier 1 teardown that tier 2 overtakes in the same pass. The listener asks after every `destroyContainer` of a tracked container; the ownership rule is what keeps a tier 1 preview's network, and the orchestrator on it. A container that goes another way — a failed creation, the boot orphan removal, a removal from outside ShipIt — raises no event, and its network waits for the boot sweep.
- **`downComposeStackByProject`**, for the stacks a previous orchestrator left — an orchestrator container that restarts in place re-attaches to every network it was on, and a plain removal fails on that. Its callers hold the stack queue, and no manager exists for such a stack.

Nothing needs the network between a stop and the next start: `up` creates it again, and the `start` that runs it ends in `joinSessionNetwork`.

One interval stays open, and it is older than this change: `ServiceManager.stop` neither cancels nor waits for an `up` that the same manager already has in flight outside the queue (a `refreshSecrets` whose build is still running, for example). That `up` can finish after the `down`, and leaves a stack that no manager owns. The release can then have removed the network that the late `up` was about to use, or the late `up` creates the network again without the orchestrator on it. Nothing routes to such a stack in either case, and `reapSurvivingComposeStacks` takes it down at the next boot.

The boot sweep's rule changed with it. A dangling session network was kept whenever its session was in the store, so a leak lasted as long as the session row. `sweepOrphanSessionNetworks` (`startup-janitor.ts`) now also takes the **Compose** network of a stored session that holds no runner, container, stack or restore in this process (`isSessionLive`). Only that network: Compose creates it under a `ServiceManager` that is already in `serviceManagers` (verified at `setupServiceManager` and `preStartWarmPreview`), so a start in flight reads as live. The Docker-access and egress networks are created before the container record exists (`createContainer`), so they keep the store-membership guard. The removal is `releaseSessionNetwork` again, because `dangling` means "no endpoint" and a stopped container that still names the network has none; without a Docker client to list containers with, a stored session keeps its network. The last liveness check and the removal run together in the session's stack queue, because a manager that registers after the removal was issued cannot call it back. The sweep is still `dangling=true` and stack-scoped: a network that the orchestrator alone holds is not swept. After an orchestrator restart in place — which re-attaches it to every network it was on — such a network goes at the next stop of its session, or when the orchestrator container is next recreated.

The pool is the other half. ShipIt asks for no subnet size, so each network takes one whole network of the default pools. `deployment/vps/setup.sh` widens the pool on a VPS. A local install has the daemon's default, so `warnIfAddressPoolIsSmall` (`docker-address-pool.ts`) reports it at startup, and the preview's error hint names where the setting is in Docker Desktop as well as on a Linux daemon.

### Edge case: active sessions with stale compose stacks

Sessions that still exist in the DB but whose compose stacks are orphaned (orchestrator restarted mid-session) are handled by the existing `ServiceManager.killStaleContainers()`, which runs at the start of `ServiceManager.start()` when the session is re-activated. No change needed.

## Key files

| File | Role |
|------|------|
| `src/server/orchestrator/compose-generator.ts` | Add `shipit-stack` label to compose override |
| `src/server/orchestrator/compose-cli.ts` | `up` recovery when a changed network definition meets ShipIt's own endpoints |
| `src/server/orchestrator/session-network-release.ts` | `releaseSessionNetwork()` — removes a session network that only the orchestrator is attached to |
| `src/server/orchestrator/startup-janitor.ts` | Boot sweeps, including the dangling session networks |
| `src/server/orchestrator/docker-address-pool.ts` | Startup warning for a default-sized address pool |
| `src/server/orchestrator/container-discovery.ts` | Add `cleanupOrphanComposeResources()` |
| `src/server/orchestrator/container-lifecycle.ts` | Existing `cleanupSessionDockerResources()` — reused, not modified |
| `src/server/orchestrator/app-lifecycle.ts` | Pass stack name to ServiceManager; call new cleanup function during startup |
| `docker/local/dev.sh` | Add compose container cleanup line |
| `docker/local/prod.sh` | Add compose container cleanup line |
| `deployment/hetzner/deploy.sh` | Add compose container cleanup line |
