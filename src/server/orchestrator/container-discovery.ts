import type Docker from "dockerode";
import type { SessionContainer } from "./session-container.js";
import {
  CONTAINER_BUILD_ID_LABEL,
  CONTAINER_SESSION_ID_LABEL,
  CONTAINER_STANDBY_LABEL,
} from "./session-container.js";
import { stackLabelFilters } from "./stack-label.js";
import { cleanupSessionDockerResources } from "./container-lifecycle.js";
import { getContainerFreshness } from "./container-freshness.js";
import { overlayDepDirsFromMounts } from "./overlay-session.js";
import { setWorkerAuthToken, workerTokenFromContainerEnv } from "./worker-auth.js";
import { isShipItOwnSession } from "./shipit-own-sessions.js";
import {
  CPU_PERIOD_US as DEFAULT_CPU_PERIOD_US,
  deriveSessionCpuSizing,
  SESSION_CPU_SHARES,
} from "./container-config-builder.js";

export interface DiscoveryDeps {
  docker: Docker;
  containers: Map<string, SessionContainer>;
  standbySessionIds: Set<string>;
  networkName: string;
  workerPort: number;
  labelFilters: () => string[];
}

/**
 * A worker survives an orchestrator deploy, so without this it keeps whatever CPU policy it was
 * created under — the whole-host quota and default weight that starved the orchestrator in the
 * first place (docs/229). cgroup CPU limits are writable live, so this needs no restart.
 *
 * Only session workers: a container ShipIt owns (the cleanup worker) is created from its own
 * deliberately smaller budget, and adopting it under the session formula would silently widen it.
 */
async function reconcileAdoptedCpuPolicy(
  sessionId: string,
  container: Docker.Container,
  hostConfig: Docker.ContainerInspectInfo["HostConfig"] | undefined,
  cpuQuota: number,
): Promise<{ memoryLimit: number; cpuQuota: number; pidsLimit: number } | undefined> {
  // The quota means nothing without its period: 700000µs buys 7 cores per 100ms and 14 per 50ms.
  // Report it on the 100ms basis every consumer of `bootedLimits` assumes.
  const bootedPeriod = hostConfig?.CpuPeriod || DEFAULT_CPU_PERIOD_US;
  const booted = hostConfig && {
    memoryLimit: hostConfig.Memory ?? 0,
    cpuQuota: Math.round((hostConfig.CpuQuota ?? 0) * (DEFAULT_CPU_PERIOD_US / bootedPeriod)),
    pidsLimit: hostConfig.PidsLimit ?? 0,
  };
  if (isShipItOwnSession(sessionId)) return booted;

  const stale = booted?.cpuQuota !== cpuQuota || hostConfig?.CpuShares !== SESSION_CPU_SHARES;
  if (!stale) return booted;
  try {
    // CPU only: lowering a live Memory limit below current usage invites the OOM killer, and the
    // pids guard never changed.
    const res = await container.update({
      CpuQuota: cpuQuota, CpuPeriod: DEFAULT_CPU_PERIOD_US, CpuShares: SESSION_CPU_SHARES,
    }) as { Warnings?: string[] } | undefined;
    // The daemon reports a silently-dropped CPU setting as a warning on a 200, not as an error.
    const warnings = res?.Warnings ?? [];
    if (warnings.length > 0) {
      console.warn(
        `[adopt] session ${sessionId}: daemon warned on the CPU policy update, treating it as `
          + `not applied: ${warnings.join("; ")}`,
      );
      return booted;
    }
    console.log(
      `[adopt] session ${sessionId}: CPU policy updated in place — quota ${booted?.cpuQuota ?? "?"}`
        + `/${bootedPeriod} → ${cpuQuota}/${DEFAULT_CPU_PERIOD_US}, `
        + `shares ${hostConfig?.CpuShares || "unset"} → ${SESSION_CPU_SHARES}`,
    );
    return booted && { ...booted, cpuQuota };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[adopt] session ${sessionId}: CPU policy update failed, keeping booted limits: ${detail}`);
    return booted;
  }
}

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
        // Bind mount validation needs a resolved workspace.
        if (!resolved?.workspaceDir) continue;
        const dockerAccess = resolved.dockerAccess;
        // The previous process stored the worker token only in the container environment.
        const workerUrl = `http://${networkInfo.IPAddress}:${deps.workerPort}`;
        const workerToken = workerTokenFromContainerEnv(info.Config?.Env);
        setWorkerAuthToken(workerUrl, workerToken);
        const cpuQuota = resolved.resourceLimits?.cpuQuota ?? deriveSessionCpuSizing().cpuQuota;
        const bootedLimits = await reconcileAdoptedCpuPolicy(
          sessionId, container, info.HostConfig, cpuQuota,
        );
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
          bootedLimits,
          // Use actual mounts; workspace configuration may have changed since creation.
          overlayDepDirs: overlayDepDirsFromMounts(sessionId, info.Mounts),
        });
        // Do not restore standby status: the immutable label survives a claim.
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
        if (!resolved?.workspaceDir) return false;
        const dockerAccess = resolved.dockerAccess;
        const workerUrl = `http://${networkInfo.IPAddress}:${deps.workerPort}`;
        const workerToken = workerTokenFromContainerEnv(info.Config?.Env);
        setWorkerAuthToken(workerUrl, workerToken);
        const cpuQuota = resolved.resourceLimits?.cpuQuota ?? deriveSessionCpuSizing().cpuQuota;
        const bootedLimits = await reconcileAdoptedCpuPolicy(
          sessionId, container, info.HostConfig, cpuQuota,
        );
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
          bootedLimits,
          overlayDepDirs: overlayDepDirsFromMounts(sessionId, info.Mounts),
        });
        logAdoptedWorkerBuild(sessionId, ci.Id, ci.Labels);
        return true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(
          `[adopt] inspect failed for container ${ci.Id.slice(0, 12)} (session ${sessionId}): ${detail}`,
        );
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[adopt] listContainers failed for session ${sessionId}: ${detail}`);
  }
  return false;
}

/** Undefined means Docker could not answer; only false proves the container is stopped or gone. */
export async function isTrackedContainerRunning(
  deps: DiscoveryDeps,
  sessionId: string,
): Promise<boolean | undefined> {
  const sc = deps.containers.get(sessionId);
  if (!sc?.id) return undefined;
  try {
    const info = await deps.docker.getContainer(sc.id).inspect();
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

/**
 * Run at boot after retiring warm rows. Active rows protect claimed containers whose standby label remains.
 * Stack-scoped via `labelFilters()`: another instance's warm pool is not in this store (planning#584).
 */
export async function reapStandbyContainers(
  deps: DiscoveryDeps,
  activeSessionIds: Set<string>,
): Promise<number> {
  let removed = 0;
  try {
    const containers = await deps.docker.listContainers({
      all: true,
      filters: { label: [`${CONTAINER_STANDBY_LABEL}=true`, ...deps.labelFilters()] },
    });
    for (const ci of containers) {
      if (ci.Labels?.[CONTAINER_STANDBY_LABEL] !== "true") continue;
      const sessionId = ci.Labels?.[CONTAINER_SESSION_ID_LABEL];
      if (sessionId && activeSessionIds.has(sessionId)) continue;
      try {
        const container = deps.docker.getContainer(ci.Id);
        if (ci.State === "running") await container.stop({ t: 5 });
        await container.remove({ force: true });
        removed++;
      } catch {
        // Continue clearing local tracking if Docker teardown fails.
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

export async function cleanupOrphanContainers(
  deps: DiscoveryDeps,
  activeSessionIds: Set<string>,
): Promise<number> {
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
      // An id the session store has never heard of is not proof of an orphan;
      // ShipIt labels its own containers with ids it holds no row for. Guarded
      // here rather than in each caller's active set (docs/299 req 8).
      if (sessionId && isShipItOwnSession(sessionId)) continue;
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

const PARENT_SESSION_LABEL = "shipit-parent-session";

/** Stack-scoped for the reason on `stackLabelFilters`; `cleanupOrphanContainers` always was. */
export async function cleanupOrphanComposeResources(
  docker: Docker,
  activeSessionIds: Set<string>,
  opts: { stackName?: string } = {},
): Promise<number> {
  let removed = 0;
  const stackFilters = stackLabelFilters(opts.stackName);
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [PARENT_SESSION_LABEL, ...stackFilters] },
    });

    const orphanedSessionIds = new Set<string>();
    for (const ci of containers) {
      const sessionId = ci.Labels?.[PARENT_SESSION_LABEL];
      // The cleanup container's egress sidecars carry its reserved id; reaping
      // them leaves its worker with firewall redirects and no resolver.
      if (sessionId && isShipItOwnSession(sessionId)) continue;
      if (sessionId && !activeSessionIds.has(sessionId)) {
        orphanedSessionIds.add(sessionId);
        removed++;
      }
    }

    for (const sessionId of orphanedSessionIds) {
      await cleanupSessionDockerResources(docker, sessionId, { labelFilters: stackFilters });
    }
  } catch {
    // Docker may not be available
  }
  return removed;
}

export function getSessionByContainerIp(
  containers: Map<string, SessionContainer>,
  ip: string,
): SessionContainer | undefined {
  for (const sc of containers.values()) {
    if (sc.containerIp === ip) return sc;
  }
  return undefined;
}
