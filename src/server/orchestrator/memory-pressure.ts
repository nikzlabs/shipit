/**
 * Memory pressure thresholds and helpers shared between the periodic
 * stats poller and the idle enforcer.
 *
 * Why two thresholds:
 *  - **Banner** fires earlier (80%) so the user sees a warning before
 *    the orchestrator starts evicting things underneath them.
 *  - **Eviction** fires later (85%) so we don't churn the warm pool on
 *    every minor spike.
 *
 * The 5-point gap is hysteresis: once the banner is up, the user has
 * a window to act (close a tab, archive a session) before automatic
 * eviction kicks in.
 */

import type { DockerMemoryStats } from "../shared/types.js";

/** Above this fraction of host memory used, the client renders a memory-pressure banner. */
export const MEMORY_PRESSURE_BANNER_THRESHOLD = 0.80;

/**
 * Above this fraction of host memory used, the idle enforcer becomes
 * aggressive: bypasses the 60s grace period and drops effective
 * `maxIdleContainers` to 0. Set higher than the banner threshold so
 * users get a warning before automatic eviction starts.
 */
export const MEMORY_PRESSURE_EVICT_THRESHOLD = 0.85;

/**
 * Compute the fraction of host memory currently in use across all
 * running containers, or `null` when stats aren't available yet
 * (orchestrator just started, Docker unreachable, or `MemTotal` is 0).
 */
export function memoryUsedFraction(stats: DockerMemoryStats | null): number | null {
  if (!stats) return null;
  if (stats.totalBytes <= 0) return null;
  return stats.usedBytes / stats.totalBytes;
}

/** True when memory usage has crossed the eviction threshold. */
export function isUnderEvictionPressure(stats: DockerMemoryStats | null): boolean {
  const frac = memoryUsedFraction(stats);
  return frac !== null && frac >= MEMORY_PRESSURE_EVICT_THRESHOLD;
}
