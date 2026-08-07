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
        });
        if (ci.Labels?.[CONTAINER_STANDBY_LABEL] === "true") {
          deps.standbySessionIds.add(sessionId);
        }
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
        });
        if (ci.Labels?.[CONTAINER_STANDBY_LABEL] === "true") {
          deps.standbySessionIds.add(sessionId);
        }
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
