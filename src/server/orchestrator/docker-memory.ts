/**
 * Reads aggregate memory stats for all running Docker containers via the Docker API.
 * Returns the sum of memory used by all containers and the total memory
 * available to Docker (host memory).
 */

import Docker from "dockerode";
import type { DockerMemoryStats } from "../shared/types.js";

interface ContainerStats { memory_stats?: { usage?: number } }

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

    // Sum memory usage across all containers
    let usedBytes = 0;
    const statPromises = containers.map(async (ci) => {
      try {
        const container = docker.getContainer(ci.Id);
        // stream: false returns a single stats snapshot instead of a stream
        const stats: ContainerStats = await container.stats({ stream: false }) as ContainerStats;
        return stats.memory_stats?.usage ?? 0;
      } catch {
        return 0;
      }
    });
    const usages = await Promise.all(statPromises);
    for (const u of usages) usedBytes += u;

    return { usedBytes, totalBytes };
  } catch {
    return null;
  }
}
