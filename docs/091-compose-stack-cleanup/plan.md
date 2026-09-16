
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

### Edge case: active sessions with stale compose stacks

Sessions that still exist in the DB but whose compose stacks are orphaned (orchestrator restarted mid-session) are handled by the existing `ServiceManager.killStaleContainers()`, which runs at the start of `ServiceManager.start()` when the session is re-activated. No change needed.

## Key files

| File | Role |
|------|------|
| `src/server/orchestrator/compose-generator.ts` | Add `shipit-stack` label to compose override |
| `src/server/orchestrator/container-discovery.ts` | Add `cleanupOrphanComposeResources()` |
| `src/server/orchestrator/container-lifecycle.ts` | Existing `cleanupSessionDockerResources()` — reused, not modified |
| `src/server/orchestrator/app-lifecycle.ts` | Pass stack name to ServiceManager; call new cleanup function during startup |
| `docker/local/dev.sh` | Add compose container cleanup line |
| `docker/local/prod.sh` | Add compose container cleanup line |
| `deployment/hetzner/deploy.sh` | Add compose container cleanup line |
