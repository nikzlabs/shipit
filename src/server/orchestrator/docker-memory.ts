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

/*
 * These two labels only. ShipIt runs other session-scoped containers — plugin
 * CLI runs, plugin installs, egress namespace holders — under their own labels
 * (`shipit-plugin-cli`, `shipit-plugin-install`, `shipit-plugin-netns`). They
 * are deliberately NOT attributed here: `bySession` answers exactly one
 * question, "how much would reclaiming this session give back", and neither
 * reclaim tier stops those. Their memory still counts in `usedBytes`, so the
 * shortfall they contribute to is real; what would be wrong is promising it
 * back. They are also short-lived by construction.
 */

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
        return { bytes: stats.memory_stats?.usage ?? 0, labels: ci.Labels ?? {}, ok: true };
      } catch {
        // A failed read is UNKNOWN, not zero. Attributing 0 to the session
        // would create a truthy `bySession` entry, and the enforcer reads a
        // present entry as "measured" — so it would keep reclaiming on the
        // strength of a number nobody read.
        return { bytes: 0, labels: ci.Labels ?? {}, ok: false };
      }
    });
    const readings = await Promise.all(statPromises);
    const unreadable = new Set<string>();
    for (const { labels, ok } of readings) {
      if (ok) continue;
      const owner = labels[AGENT_SESSION_LABEL] ?? labels[SERVICE_SESSION_LABEL];
      if (owner) unreadable.add(owner);
    }
    for (const { bytes, labels, ok } of readings) {
      usedBytes += bytes;
      if (!ok) continue;
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

    // Drop any session with an unreadable container: a partial sum would be
    // read as the whole of what stopping it frees.
    const attributed = Object.fromEntries(
      Object.entries(bySession).filter(([sessionId]) => !unreadable.has(sessionId)),
    );

    return { usedBytes, totalBytes, bySession: attributed };
  } catch {
    return null;
  }
}
