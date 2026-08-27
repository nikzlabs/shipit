/**
 * Reads aggregate memory stats for all running Docker containers via the Docker API.
 * Returns the sum of memory used by all containers and the total memory
 * available to Docker (host memory).
 *
 * docs/284 — it also attributes usage to sessions. The idle enforcer reclaims
 * to get back under a *memory* budget, so it needs to know what stopping a
 * given session would actually free; a container count cannot tell it that,
 * which is the whole reason the count setting was replaced.
 */

import Docker from "dockerode";
import type { DockerMemoryStats, SessionMemoryUsage } from "../shared/types.js";

interface ContainerStats { memory_stats?: { usage?: number } }

/** Label an agent (session worker) container carries: `session-container.ts`. */
const AGENT_SESSION_LABEL = "shipit-session-id";
/**
 * Label every Compose service container carries, written into the generated
 * override by `compose-generator.ts`. It holds the FULL session id, so service
 * usage attributes without going through the `shipit-{sid12}` project name.
 */
const SERVICE_SESSION_LABEL = "shipit-parent-session";

/**
 * Read aggregate memory stats for all running Docker containers.
 * Returns null if Docker is not available or stats can't be read.
 */
export async function readDockerMemoryStats(
  docker: Docker,
): Promise<DockerMemoryStats | null> {
  try {
    // Get Docker host total memory
    const info: { MemTotal?: number } = await docker.info() as { MemTotal?: number };
    const totalBytes = info.MemTotal ?? 0;

    // List ALL running containers
    const containers = await docker.listContainers({
      filters: { status: ["running"] },
    });

    // Sum memory usage across all containers, attributing each to a session
    // where its labels say so.
    let usedBytes = 0;
    const bySession: Record<string, SessionMemoryUsage> = {};
    const statPromises = containers.map(async (ci) => {
      try {
        const container = docker.getContainer(ci.Id);
        // stream: false returns a single stats snapshot instead of a stream
        const stats: ContainerStats = await container.stats({ stream: false });
        return { bytes: stats.memory_stats?.usage ?? 0, labels: ci.Labels ?? {} };
      } catch {
        return { bytes: 0, labels: ci.Labels ?? {} };
      }
    });
    const readings = await Promise.all(statPromises);
    for (const { bytes, labels } of readings) {
      usedBytes += bytes;
      const agentOf = labels[AGENT_SESSION_LABEL];
      const serviceOf = labels[SERVICE_SESSION_LABEL];
      // An agent container carries only the first label and a service container
      // only the second, so these are not exclusive branches over one id — a
      // container that somehow carried both would be counted in both buckets
      // for the same session, never for two sessions.
      if (agentOf) {
        (bySession[agentOf] ??= { agentBytes: 0, serviceBytes: 0 }).agentBytes += bytes;
      }
      if (serviceOf) {
        (bySession[serviceOf] ??= { agentBytes: 0, serviceBytes: 0 }).serviceBytes += bytes;
      }
    }

    return { usedBytes, totalBytes, bySession };
  } catch {
    return null;
  }
}
