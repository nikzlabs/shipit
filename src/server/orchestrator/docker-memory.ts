/**
 * Reads Docker container memory stats from cgroup filesystem.
 * Works for both cgroup v2 (modern) and cgroup v1 (legacy).
 */

import fs from "node:fs/promises";
import type { DockerMemoryStats } from "../shared/types.js";

// cgroup v2 paths
const CGROUP_V2_CURRENT = "/sys/fs/cgroup/memory.current";
const CGROUP_V2_MAX = "/sys/fs/cgroup/memory.max";

// cgroup v1 paths
const CGROUP_V1_USAGE = "/sys/fs/cgroup/memory/memory.usage_in_bytes";
const CGROUP_V1_LIMIT = "/sys/fs/cgroup/memory/memory.limit_in_bytes";

async function readFileAsNumber(path: string): Promise<number | null> {
  try {
    const content = (await fs.readFile(path, "utf-8")).trim();
    if (content === "max") return 0; // unlimited
    const n = parseInt(content, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/**
 * Read Docker memory stats from cgroup filesystem.
 * Returns null if not running inside a container or cgroup info is unavailable.
 */
export async function readDockerMemoryStats(): Promise<DockerMemoryStats | null> {
  // Try cgroup v2 first
  let used = await readFileAsNumber(CGROUP_V2_CURRENT);
  let total = await readFileAsNumber(CGROUP_V2_MAX);

  if (used !== null && total !== null) {
    return { usedBytes: used, totalBytes: total };
  }

  // Fall back to cgroup v1
  used = await readFileAsNumber(CGROUP_V1_USAGE);
  total = await readFileAsNumber(CGROUP_V1_LIMIT);

  if (used !== null && total !== null) {
    return { usedBytes: used, totalBytes: total };
  }

  return null;
}
