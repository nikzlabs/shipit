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
 *
 * docs/284 — both fractions are taken against the user's **memory budget**,
 * not raw host memory. The budget is what decides reclaim, so a banner
 * measured against the host would warn at a moment unrelated to when things
 * actually start being stopped: on a 64 GB host with a 16 GB budget it would
 * never fire at all (req 12). The thresholds and their gap are unchanged —
 * only what they are a fraction *of*.
 */

import type { DockerMemoryStats } from "../shared/types.js";

/** Above this fraction of the memory budget used, the client renders a memory-pressure banner. */
export const MEMORY_PRESSURE_BANNER_THRESHOLD = 0.80;

/**
 * Above this fraction of the memory budget used, the idle enforcer reclaims
 * idle sessions until usage is back under the budget. Set higher than the
 * banner threshold so users get a warning before automatic eviction starts.
 */
export const MEMORY_PRESSURE_EVICT_THRESHOLD = 0.85;

/**
 * Resolve the number pressure is measured against: the configured budget,
 * clamped by what the machine actually has.
 *
 * Host-as-ceiling is load-bearing twice over (req 12). A budget larger than
 * the host must not be able to switch the OOM safety net off — usage can never
 * reach it, so nothing would ever be reclaimed. And an **unset** budget must
 * reproduce today's behaviour exactly, which falls out of the same line: with
 * no budget the answer is the host total, which is what the fraction used
 * before this existed (req 9).
 *
 * Returns 0 when the host total is unknown, which callers read as
 * "no answer available" rather than as a budget of zero.
 */
export function effectiveBudgetBytes(
  totalBytes: number,
  budgetMb: number | null | undefined,
): number {
  if (totalBytes <= 0) return 0;
  if (budgetMb === null || budgetMb === undefined || budgetMb <= 0) return totalBytes;
  return Math.min(totalBytes, Math.floor(budgetMb) * 1024 * 1024);
}

/**
 * Compute the fraction of the memory budget currently in use across all
 * running containers, or `null` when stats aren't available yet
 * (orchestrator just started, Docker unreachable, or `MemTotal` is 0).
 *
 * Reads `stats.budgetBytes` when the poller already resolved it, so the
 * enforcer and the client agree on one number rather than each recomputing
 * it from a setting they may have read at different times.
 */
export function memoryUsedFraction(stats: DockerMemoryStats | null): number | null {
  if (!stats) return null;
  const budget = stats.budgetBytes && stats.budgetBytes > 0
    ? stats.budgetBytes
    : stats.totalBytes;
  if (budget <= 0) return null;
  return stats.usedBytes / budget;
}

/** True when memory usage has crossed the eviction threshold. */
export function isUnderEvictionPressure(stats: DockerMemoryStats | null): boolean {
  const frac = memoryUsedFraction(stats);
  return frac !== null && frac >= MEMORY_PRESSURE_EVICT_THRESHOLD;
}

/**
 * Bytes that must be freed to bring usage back under the eviction threshold,
 * or 0 when already under it. The idle enforcer reclaims until this reaches 0
 * rather than to an arbitrary container count.
 *
 * The target is the threshold, not the budget itself: stopping exactly enough
 * to land on the eviction line would put the next poll straight back into
 * pressure, and the reclaim would oscillate.
 */
export function bytesOverBudget(stats: DockerMemoryStats | null): number {
  if (!stats) return 0;
  const budget = stats.budgetBytes && stats.budgetBytes > 0
    ? stats.budgetBytes
    : stats.totalBytes;
  if (budget <= 0) return 0;
  return Math.max(0, stats.usedBytes - budget * MEMORY_PRESSURE_EVICT_THRESHOLD);
}
