import type { DockerMemoryStats } from "../shared/types.js";
import type { DeploymentMode } from "./deployment-mode.js";

export const MEMORY_PRESSURE_BANNER_THRESHOLD = 0.80;
export const MEMORY_PRESSURE_EVICT_THRESHOLD = 0.85;
export const BUDGET_BANNER_THRESHOLD = 0.90;
export const LOCAL_DEFAULT_BUDGET_FRACTION = 0.5;

export interface MemoryTargets {
  budgetBytes: number;
  warnAtBytes: number;
  evictAtBytes: number;
}

// Zero targets mean host memory is unknown, not a zero-byte budget.
export function resolveMemoryTargets(
  totalBytes: number,
  budgetMb: number | null | undefined,
  deployment: DeploymentMode = "server",
): MemoryTargets {
  if (totalBytes <= 0) return { budgetBytes: 0, warnAtBytes: 0, evictAtBytes: 0 };
  const configured = budgetMb !== null && budgetMb !== undefined && budgetMb > 0
    ? Math.min(totalBytes, Math.floor(budgetMb) * 1024 * 1024)
    : null;
  const explicit = configured
    ?? (deployment === "local" ? totalBytes * LOCAL_DEFAULT_BUDGET_FRACTION : null);
  if (explicit === null) {
    return {
      budgetBytes: totalBytes,
      warnAtBytes: totalBytes * MEMORY_PRESSURE_BANNER_THRESHOLD,
      evictAtBytes: totalBytes * MEMORY_PRESSURE_EVICT_THRESHOLD,
    };
  }
  return {
    budgetBytes: explicit,
    warnAtBytes: explicit * BUDGET_BANNER_THRESHOLD,
    evictAtBytes: explicit,
  };
}

export function targetsOf(stats: DockerMemoryStats): MemoryTargets {
  if (stats.evictAtBytes !== undefined && stats.warnAtBytes !== undefined) {
    return {
      budgetBytes: stats.budgetBytes && stats.budgetBytes > 0 ? stats.budgetBytes : stats.totalBytes,
      warnAtBytes: stats.warnAtBytes,
      evictAtBytes: stats.evictAtBytes,
    };
  }
  return resolveMemoryTargets(stats.totalBytes, null);
}

export function memoryUsedFraction(stats: DockerMemoryStats | null): number | null {
  if (!stats) return null;
  const { budgetBytes } = targetsOf(stats);
  if (budgetBytes <= 0) return null;
  return stats.usedBytes / budgetBytes;
}

export function isUnderBannerPressure(stats: DockerMemoryStats | null): boolean {
  if (!stats) return false;
  const { warnAtBytes } = targetsOf(stats);
  return warnAtBytes > 0 && stats.usedBytes >= warnAtBytes;
}

// At the limit, stop adding warm containers even though bytesOverBudget is still zero.
export function isUnderEvictionPressure(stats: DockerMemoryStats | null): boolean {
  if (!stats) return false;
  const { evictAtBytes } = targetsOf(stats);
  return evictAtBytes > 0 && stats.usedBytes >= evictAtBytes;
}

export function bytesOverBudget(stats: DockerMemoryStats | null): number {
  if (!stats) return 0;
  const { evictAtBytes } = targetsOf(stats);
  if (evictAtBytes <= 0) return 0;
  return Math.max(0, stats.usedBytes - evictAtBytes);
}
