import Docker from "dockerode";
import type { DockerMemoryStats, SessionMemoryUsage } from "../shared/types.js";

interface ContainerStats { memory_stats?: { usage?: number } }

// Attribute only containers the reclaim tiers can stop; plugin containers count in the total.
const AGENT_SESSION_LABEL = "shipit-session-id";
const SERVICE_SESSION_LABEL = "shipit-parent-session";

export async function readDockerMemoryStats(
  docker: Docker,
): Promise<DockerMemoryStats | null> {
  try {
    const info: { MemTotal?: number } = await docker.info() as { MemTotal?: number };
    const totalBytes = info.MemTotal ?? 0;

    const containers = await docker.listContainers({
      filters: { status: ["running"] },
    });

    let usedBytes = 0;
    const bySession: Record<string, SessionMemoryUsage> = {};
    const statPromises = containers.map(async (ci) => {
      try {
        const container = docker.getContainer(ci.Id);
        const stats: ContainerStats = await container.stats({ stream: false });
        return { bytes: stats.memory_stats?.usage ?? 0, labels: ci.Labels ?? {}, ok: true };
      } catch {
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
      if (agentOf) {
        (bySession[agentOf] ??= { agentBytes: 0, serviceBytes: 0 }).agentBytes += bytes;
      }
      if (serviceOf) {
        (bySession[serviceOf] ??= { agentBytes: 0, serviceBytes: 0 }).serviceBytes += bytes;
      }
    }

    // A partial reading must not be reported as the session's total reclaimable memory.
    const attributed = Object.fromEntries(
      Object.entries(bySession).filter(([sessionId]) => !unreadable.has(sessionId)),
    );

    return { usedBytes, totalBytes, bySession: attributed };
  } catch {
    return null;
  }
}
