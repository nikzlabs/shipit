/**
 * Memory targets and pressure helpers shared between the periodic stats poller
 * and the idle enforcer.
 *
 * docs/284 — there are two regimes, and they deliberately differ:
 *
 *  - **The user set a budget.** It is a number they chose for ShipIt, so it is
 *    taken literally: reclaim starts when usage reaches the budget, not before
 *    (reqs 3 and 5 — previews survive *until the budget is reached*). Warning
 *    at 90% of it keeps the hysteresis the banner exists for: the user sees it
 *    coming before anything is stopped.
 *  - **No budget.** What "the machine" means depends on whose machine it is
 *    (req 13). On a **server** deployment the host is ShipIt's, so the
 *    long-standing 80%/85% host fractions stand unchanged — which is what makes
 *    an unset budget byte-for-byte today's behaviour there (req 9). On a
 *    **local** install the user is working on that machine too, so the default
 *    is half of it, applied exactly like a budget the user typed.
 *
 * The host is a hard ceiling in both regimes: a budget larger than the machine
 * clamps to it, or usage could never reach the number and nothing would ever be
 * reclaimed.
 */

import type { DockerMemoryStats } from "../shared/types.js";
import type { DeploymentMode } from "./deployment-mode.js";

/** Fraction of HOST memory used at which the client renders a banner (no budget set). */
export const MEMORY_PRESSURE_BANNER_THRESHOLD = 0.80;

/** Fraction of HOST memory used at which the enforcer reclaims (no budget set). */
export const MEMORY_PRESSURE_EVICT_THRESHOLD = 0.85;

/** Fraction of an EXPLICIT budget at which the client renders a banner. */
export const BUDGET_BANNER_THRESHOLD = 0.90;

/**
 * Default share of the machine ShipIt takes on a `local` deployment (req 13).
 *
 * Half, because the other half is the user's: their editor, browser and
 * whatever they are actually building. It is a default, not a cap — the
 * Memory Budget setting overrides it in either direction.
 */
export const LOCAL_DEFAULT_BUDGET_FRACTION = 0.5;

/** The three numbers every consumer of a memory snapshot needs. */
export interface MemoryTargets {
  /** What usage is reported against, and what the user set (or the host). */
  budgetBytes: number;
  /** Usage at or above this renders the memory banner. */
  warnAtBytes: number;
  /** Usage above this makes the enforcer reclaim, down to this line. */
  evictAtBytes: number;
}

/**
 * Resolve the budget and its warn/evict lines. `totalBytes` is host memory;
 * `budgetMb` is the user's setting, or null/undefined for the deployment's
 * default; `deployment` decides what that default is (see
 * {@link LOCAL_DEFAULT_BUDGET_FRACTION}).
 *
 * All three are 0 when host memory is unknown, which callers read as "no answer
 * available" rather than as a budget of zero.
 */
export function resolveMemoryTargets(
  totalBytes: number,
  budgetMb: number | null | undefined,
  deployment: DeploymentMode = "server",
): MemoryTargets {
  if (totalBytes <= 0) return { budgetBytes: 0, warnAtBytes: 0, evictAtBytes: 0 };
  const configured = budgetMb !== null && budgetMb !== undefined && budgetMb > 0
    ? Math.min(totalBytes, Math.floor(budgetMb) * 1024 * 1024)
    : null;
  // A local install's default is a real budget, not a softer host fraction: the
  // user gets back the half ShipIt is not using, rather than watching it creep
  // toward 85% of everything.
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

/**
 * Read the targets a snapshot was stamped with, falling back to the host-only
 * regime for a snapshot that predates them (a test fixture, or a reading taken
 * before the poller resolved a budget).
 */
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

/**
 * Fraction of the budget currently in use, or `null` when stats aren't
 * available yet (orchestrator just started, Docker unreachable, `MemTotal` 0).
 * For display: the enforcer and the banner both key off the byte lines above,
 * not off this.
 */
export function memoryUsedFraction(stats: DockerMemoryStats | null): number | null {
  if (!stats) return null;
  const { budgetBytes } = targetsOf(stats);
  if (budgetBytes <= 0) return null;
  return stats.usedBytes / budgetBytes;
}

/** True when the banner should be shown. */
export function isUnderBannerPressure(stats: DockerMemoryStats | null): boolean {
  if (!stats) return false;
  const { warnAtBytes } = targetsOf(stats);
  return warnAtBytes > 0 && stats.usedBytes >= warnAtBytes;
}

/**
 * True when memory usage has reached the line at which ShipIt reclaims.
 *
 * Inclusive, matching req 5's "until that budget is reached". At exactly the
 * line {@link bytesOverBudget} is 0, so the enforcer reclaims nothing — but the
 * warm pool stops adding speculative standbys, which is the right answer at a
 * ceiling.
 */
export function isUnderEvictionPressure(stats: DockerMemoryStats | null): boolean {
  if (!stats) return false;
  const { evictAtBytes } = targetsOf(stats);
  return evictAtBytes > 0 && stats.usedBytes >= evictAtBytes;
}

/**
 * Bytes that must be freed to get back to the evict line, or 0 when already
 * under it. The idle enforcer reclaims until this reaches 0 rather than to an
 * arbitrary container count.
 */
export function bytesOverBudget(stats: DockerMemoryStats | null): number {
  if (!stats) return 0;
  const { evictAtBytes } = targetsOf(stats);
  if (evictAtBytes <= 0) return 0;
  return Math.max(0, stats.usedBytes - evictAtBytes);
}
