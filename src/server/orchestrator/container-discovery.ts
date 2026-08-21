/**
 * Container discovery — rediscover running containers and clean up orphans.
 *
 * Extracted from SessionContainerManager for single-responsibility modules.
 */

import type Docker from "dockerode";
import type { SessionContainer } from "./session-container.js";
import {
  CONTAINER_BUILD_ID_LABEL,
  CONTAINER_SESSION_ID_LABEL,
  CONTAINER_STANDBY_LABEL,
} from "./session-container.js";
import { cleanupSessionDockerResources } from "./container-lifecycle.js";
import { getContainerFreshness } from "./container-freshness.js";
import { overlayDepDirsFromMounts } from "./overlay-session.js";
import { setWorkerAuthToken, workerTokenFromContainerEnv } from "./worker-auth.js";

// ---------------------------------------------------------------------------
// Internal types for dependency injection
// ---------------------------------------------------------------------------

export interface DiscoveryDeps {
  docker: Docker;
  containers: Map<string, SessionContainer>;
  standbySessionIds: Set<string>;
  networkName: string;
  workerPort: number;
  labelFilters: () => string[];
}

// ---------------------------------------------------------------------------
// Adoption skew telemetry (docs/113)
// ---------------------------------------------------------------------------

/**
 * Log which image build an adopted container's worker is running, versus the
 * orchestrator's own build. Since deploy.sh stopped killing session containers
 * on update (docs/113 Phase 1), a worker can legitimately outlive the deploy
 * that built its image — the wire contract is additive-only (guarded by
 * worker-wire-contract.test.ts), so skew is expected and observational, but it
 * must be visible in the logs when debugging a grandfathered session.
 */
function logAdoptedWorkerBuild(
  sessionId: string,
  containerId: string,
  labels: Record<string, string> | undefined,
): void {
  const workerBuild = labels?.[CONTAINER_BUILD_ID_LABEL];
  const orchBuild = process.env.SHIPIT_BUILD_ID;
  const freshness = getContainerFreshness(workerBuild, orchBuild);
  const skew = freshness.state === "stale"
    ? " — build skew: grandfathered worker from a previous deploy"
    : "";
  console.log(
    `[adopt] session ${sessionId} container ${containerId.slice(0, 12)}: worker build ${workerBuild ?? "unknown"}, orchestrator build ${orchBuild ?? "unknown"}${skew}`,
  );
}

// ---------------------------------------------------------------------------
// Rediscover
// ---------------------------------------------------------------------------

/**
 * Rediscover running containers from a previous orchestrator run.
 * After restart, the in-memory containers map is empty even though Docker
 * containers keep running. This function queries Docker for containers with
 * the shipit-session label, and for each running container whose session ID
 * is in the active set, populates the map so the runner factory can
 * reconnect to them instead of creating duplicates.
 */
export async function rediscoverContainers(
  deps: DiscoveryDeps,
  activeSessionIds: Set<string>,
  sessionInfoResolver?: (sessionId: string) => {
    workspaceDir: string;
    dockerAccess: boolean;
    resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
  } | undefined,
): Promise<number> {
  let count = 0;
  try {
    const containers = await deps.docker.listContainers({
      all: true,
      filters: { label: deps.labelFilters() },
    });
    for (const ci of containers) {
      const sessionId = ci.Labels?.[CONTAINER_SESSION_ID_LABEL];
      if (!sessionId || !activeSessionIds.has(sessionId)) continue;
      if (deps.containers.has(sessionId)) continue;
      if (ci.State !== "running") continue;
      try {
        const container = deps.docker.getContainer(ci.Id);
        const info = await container.inspect();
        const networkInfo = info.NetworkSettings?.Networks?.[deps.networkName];
        if (!networkInfo?.IPAddress) continue;
        const resolved = sessionInfoResolver?.(sessionId);
        // Skip containers whose session info can't be resolved — without a
        // valid workspace dir, bind mount validation would be unsafe
        if (!resolved?.workspaceDir) continue;
        const dockerAccess = resolved.dockerAccess;
        // planning#313 — the container we're adopting was created by a previous
        // orchestrator process, so its worker token exists only in its own env.
        // Read it back rather than persisting a key orchestrator-side; a
        // container from before the mechanism simply has none (its worker gates
        // only the loopback-only routes).
        const workerUrl = `http://${networkInfo.IPAddress}:${deps.workerPort}`;
        const workerToken = workerTokenFromContainerEnv(info.Config?.Env);
        setWorkerAuthToken(workerUrl, workerToken);
        deps.containers.set(sessionId, {
          id: ci.Id,
          sessionId,
          containerIp: networkInfo.IPAddress,
          workerUrl,
          workerToken,
          status: "running",
          workerBuildId: ci.Labels?.[CONTAINER_BUILD_ID_LABEL] || undefined,
          hostWorkspaceDir: resolved.workspaceDir,
          dockerAccess,
          sessionNetworkName: dockerAccess ? `shipit-session-${sessionId.slice(0, 12)}` : undefined,
          resourceLimits: dockerAccess ? resolved.resourceLimits : undefined,
          // #2426 — read the dep-dir overlays back off the container's OWN mount
          // table. Left absent, `provisionedOverlayDepDirs` reports `[]` — an
          // authoritative "this container has no overlay" — and every compose
          // service in the session silently gets the plain `node_modules` while
          // the agent's install goes into the overlay. See the field's doc.
          overlayDepDirs: overlayDepDirsFromMounts(sessionId, info.Mounts),
        });
        // NOT re-marked as a standby, even when it carries the label. The label
        // is set at create time and Docker cannot change one afterwards, so a
        // claimed session's container keeps it forever — restoring the flag
        // from it marked live sessions standby, and `isStandby` gates real
        // behaviour: `restart-turn-reattach.ts` skips standbys, so an adopted
        // session's in-flight turn was silently never reattached, and the idle
        // enforcer skips them, so its container was never disposed. Anything
        // reaching here is in `activeSessionIds`, and `retireWarmSessions` has
        // already deleted every warm row — so it was claimed, by construction.
        logAdoptedWorkerBuild(sessionId, ci.Id, ci.Labels);
        count++;
      } catch {
        // Container may have exited between list and inspect
      }
    }
  } catch {
    // Docker may not be available
  }

  return count;
}

// ---------------------------------------------------------------------------
// Adopt a single running container (inverse-leak reconciler backstop)
// ---------------------------------------------------------------------------

/**
 * Re-adopt a single running Docker container into the manager map when it
 * has no `deps.containers` entry. This is the inverse leak of
 * `rediscoverContainers`: a *live* container with no map entry, which
 * happens when a `die`/`oom` event was attributed to the wrong
 * incarnation and deleted a healthy container's entry. Without
 * re-adoption the orchestrator force-disposes the runner and the next
 * attach creates yet another container — leaking the live one.
 *
 * Returns `true` when a running container was found and adopted.
 */
export async function adoptRunningContainer(
  deps: DiscoveryDeps,
  sessionId: string,
  sessionInfoResolver?: (sessionId: string) => {
    workspaceDir: string;
    dockerAccess: boolean;
    resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
  } | undefined,
): Promise<boolean> {
  if (deps.containers.has(sessionId)) return false;
  try {
    const containers = await deps.docker.listContainers({
      all: true,
      filters: { label: [`${CONTAINER_SESSION_ID_LABEL}=${sessionId}`] },
    });
    for (const ci of containers) {
      if (ci.State !== "running") continue;
      try {
        const container = deps.docker.getContainer(ci.Id);
        const info = await container.inspect();
        const networkInfo = info.NetworkSettings?.Networks?.[deps.networkName];
        if (!networkInfo?.IPAddress) continue;
        const resolved = sessionInfoResolver?.(sessionId);
        // Without a valid workspace dir, bind mount validation would be
        // unsafe — leave the container unadopted (the caller force-disposes
        // the runner, same as the no-resolver path).
        if (!resolved?.workspaceDir) return false;
        const dockerAccess = resolved.dockerAccess;
        // planning#313 — see rediscoverContainers: the token lives in the adopted
        // container's own env.
        const workerUrl = `http://${networkInfo.IPAddress}:${deps.workerPort}`;
        const workerToken = workerTokenFromContainerEnv(info.Config?.Env);
        setWorkerAuthToken(workerUrl, workerToken);
        deps.containers.set(sessionId, {
          id: ci.Id,
          sessionId,
          containerIp: networkInfo.IPAddress,
          workerUrl,
          workerToken,
          status: "running",
          workerBuildId: ci.Labels?.[CONTAINER_BUILD_ID_LABEL] || undefined,
          hostWorkspaceDir: resolved.workspaceDir,
          dockerAccess,
          sessionNetworkName: dockerAccess ? `shipit-session-${sessionId.slice(0, 12)}` : undefined,
          resourceLimits: dockerAccess ? resolved.resourceLimits : undefined,
          // #2426 — see rediscoverContainers: the overlay set is read back off
          // the adopted container's own mounts, never re-derived from a
          // workspace that has moved on since it was built.
          overlayDepDirs: overlayDepDirsFromMounts(sessionId, info.Mounts),
        });
        // Not re-marked as a standby — see `rediscoverContainers` for why the
        // label cannot answer that question. This path is stronger still: it is
        // called for a session that HAS a runner, which a standby never has.
        logAdoptedWorkerBuild(sessionId, ci.Id, ci.Labels);
        return true;
      } catch (err) {
        // Usually the container exited between `listContainers` and
        // `inspect` — benign, try the next. But this also catches a broken
        // daemon / permissions error, after which we return `false` and the
        // caller force-disposes the runner. Leave a breadcrumb so a future
        // "adoption never works" report has something to grep for.
        const detail = err instanceof Error ? err.message : String(err);
        console.error(
          `[adopt] inspect failed for container ${ci.Id.slice(0, 12)} (session ${sessionId}): ${detail}`,
        );
      }
    }
  } catch (err) {
    // Docker daemon unreachable — caller force-disposes the runner.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[adopt] listContainers failed for session ${sessionId}: ${detail}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Liveness probe for a tracked container
// ---------------------------------------------------------------------------

/**
 * Ask Docker whether the container we have tracked for `sessionId` is still
 * running.
 *
 * The manager's `containers` map is event-driven: an entry is removed when a
 * `die` arrives on the Docker event stream. That stream is fragile — it
 * reconnects with a 5s debounce, and a daemon restart takes it down entirely —
 * so a `die` delivered during a gap is simply never seen and the entry keeps
 * claiming `status: "running"` for a container that no longer exists. Nothing
 * else re-verifies it after startup, which is what left a dead session looking
 * alive (docs/121 gap E).
 *
 * Returns `undefined` — deliberately, not `false` — when Docker cannot answer.
 * The caller declares a session dead on this result, so an ambiguous failure
 * (daemon down, socket EAGAIN, permissions) must not be read as proof of
 * death; a 404 is proof, and a daemon that comes back answers definitively on
 * the next pass.
 */
export async function isTrackedContainerRunning(
  deps: DiscoveryDeps,
  sessionId: string,
): Promise<boolean | undefined> {
  const sc = deps.containers.get(sessionId);
  if (!sc?.id) return undefined;
  try {
    const info = await deps.docker.getContainer(sc.id).inspect();
    // An inspect with no `State` block tells us nothing — `undefined`, not
    // `false`, for the same reason the catch below distinguishes them.
    return info.State?.Running;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[container-liveness] inspect failed for ${sc.id.slice(0, 12)} (session ${sessionId}): ${detail}`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Standby reaping (boot)
// ---------------------------------------------------------------------------

/**
 * Stop and remove every UNCLAIMED standby container. Called once at boot.
 *
 * A standby belongs to the process that created it: it holds no work, it was
 * built from that process's worker image, and nothing else reaps one — the idle
 * enforcer skips standbys deliberately (`idle-enforcer.ts`) and
 * {@link rediscoverContainers} re-adopts them. So a standby used to outlive
 * every deploy, and the next claim of that warm session was handed a
 * grandfathered worker. Grandfathering a *real* session's container across a
 * deploy is the docs/113 rule and stays; it exists to protect work in flight,
 * which a standby by definition has none of.
 *
 * **`activeSessionIds` is not a refinement — it is what stops this destroying
 * live sessions.** The `shipit-standby` label is set at CREATE time and Docker
 * has no way to change a label afterwards, so `claimStandby` can only drop the
 * in-process flag: a claimed, graduated, entirely ordinary session keeps a
 * container labelled `shipit-standby=true` for that container's whole life.
 * Label alone therefore means "was born a standby", never "is one now". The
 * session ROW is what distinguishes them, and it does so cleanly because
 * `retireWarmSessions` has already deleted every warm row by the time this
 * runs: a labelled container whose session is still tracked was claimed by
 * someone, and one whose session is gone is an unclaimed standby.
 *
 * Given that, why key on the label at all rather than let the orphan sweep
 * handle it? Because this must hold for a container manager that is injected
 * rather than constructed here — that path skips `cleanupOrphanContainers`
 * entirely — and for a standby the orphan sweep's own filters miss.
 *
 * Egress sidecars sharing a reaped container's netns are left to the boot
 * janitor's `reapOrphanEgressSidecars`, whose test is exactly "is my netns
 * parent gone?" — which is now true for each of them.
 *
 * Never rejects. Returns the number of containers removed.
 */
export async function reapStandbyContainers(
  deps: DiscoveryDeps,
  activeSessionIds: Set<string>,
): Promise<number> {
  let removed = 0;
  try {
    const containers = await deps.docker.listContainers({
      all: true,
      filters: { label: [`${CONTAINER_STANDBY_LABEL}=true`] },
    });
    for (const ci of containers) {
      // Re-read the label at the point of removal rather than trusting the
      // filter alone. This sweep stops and removes containers; the predicate
      // that decides which ones deserves to be visible where the destruction
      // happens, not only in the query that produced the list.
      if (ci.Labels?.[CONTAINER_STANDBY_LABEL] !== "true") continue;
      const sessionId = ci.Labels?.[CONTAINER_SESSION_ID_LABEL];
      // Claimed: someone's session owns this container now, whatever it was
      // born as. See the note above — this is the docs/113 guarantee, not an
      // optimization.
      if (sessionId && activeSessionIds.has(sessionId)) continue;
      try {
        const container = deps.docker.getContainer(ci.Id);
        if (ci.State === "running") await container.stop({ t: 5 });
        await container.remove({ force: true });
        removed++;
      } catch {
        // Already gone, or removed by the orphan sweep moments ago — either
        // way the outcome we wanted. Still drop the tracking below.
      }
      if (sessionId) {
        deps.containers.delete(sessionId);
        deps.standbySessionIds.delete(sessionId);
      }
    }
  } catch {
    // Docker may not be available.
  }
  if (removed > 0) {
    console.log(`[container] Reaped ${removed} standby container(s) from the previous orchestrator process`);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

/**
 * Remove containers left over from a previous orchestrator run.
 * Scans for containers with the shipit-session label that don't match
 * any currently tracked session.
 */
export async function cleanupOrphanContainers(
  deps: DiscoveryDeps,
  activeSessionIds: Set<string>,
): Promise<number> {
  // This path emits SIGTERM via `container.stop({t:5})`. The docs/124
  // SIGTERM-loop investigation confirmed it only runs once at startup
  // (from `setupContainerManager`), so the stack-trace diagnostic that
  // used to live here was downgraded to a plain startup log line.
  console.log(`[container] cleanupOrphanContainers(active=${activeSessionIds.size})`);

  let removed = 0;
  try {
    const containers = await deps.docker.listContainers({
      all: true,
      filters: {
        label: deps.labelFilters(),
      },
    });

    for (const containerInfo of containers) {
      const sessionId = containerInfo.Labels?.[CONTAINER_SESSION_ID_LABEL];
      if (sessionId && !activeSessionIds.has(sessionId)) {
        try {
          const container = deps.docker.getContainer(containerInfo.Id);
          if (containerInfo.State === "running") {
            await container.stop({ t: 5 });
          }
          await container.remove({ force: true });
          removed++;
        } catch {
          // Container may already be gone
        }
      }
    }
  } catch {
    // Docker may not be available
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Orphan compose stack cleanup
// ---------------------------------------------------------------------------

const PARENT_SESSION_LABEL = "shipit-parent-session";

/**
 * Remove compose stack resources (containers, networks, volumes) left over
 * from a previous orchestrator run. Finds containers labeled with
 * `shipit-parent-session` whose session ID is not in the active set, then
 * delegates to `cleanupSessionDockerResources()` for the actual teardown.
 */
export async function cleanupOrphanComposeResources(
  docker: Docker,
  activeSessionIds: Set<string>,
): Promise<number> {
  let removed = 0;
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [PARENT_SESSION_LABEL] },
    });

    // Collect orphaned session IDs (deduplicate — multiple containers per session)
    const orphanedSessionIds = new Set<string>();
    for (const ci of containers) {
      const sessionId = ci.Labels?.[PARENT_SESSION_LABEL];
      if (sessionId && !activeSessionIds.has(sessionId)) {
        orphanedSessionIds.add(sessionId);
        removed++;
      }
    }

    // Clean up all resources for each orphaned session
    for (const sessionId of orphanedSessionIds) {
      await cleanupSessionDockerResources(docker, sessionId);
    }
  } catch {
    // Docker may not be available
  }
  return removed;
}

// ---------------------------------------------------------------------------
// IP lookup
// ---------------------------------------------------------------------------

/**
 * Look up a session by its container's bridge IP address.
 * Used by the Docker API proxy for source-IP routing.
 */
export function getSessionByContainerIp(
  containers: Map<string, SessionContainer>,
  ip: string,
): SessionContainer | undefined {
  for (const sc of containers.values()) {
    if (sc.containerIp === ip) return sc;
  }
  return undefined;
}
