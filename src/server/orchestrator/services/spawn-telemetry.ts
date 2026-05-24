/**
 * Spawn-invocation telemetry (docs/117 cross-cutting follow-up).
 *
 * Counts every `POST /api/sessions/:parentId/spawn` attempt — successes and
 * failures — broken down by parent session id, parent turn id, agent id, and
 * outcome category. Two surfaces:
 *
 *   - **Structured log line.** A single `[spawn-telemetry]` line per invocation
 *     so an external log scraper can build a time-series without touching
 *     orchestrator internals. The format is `key=value` pairs, the same shape
 *     `[spawn-child]` uses.
 *   - **In-process counter.** `getSpawnTelemetrySnapshot()` returns the
 *     current totals, dimensioned by `outcome`, `agent`, and (when supplied)
 *     `turn`. Lets tests assert on counting without re-parsing logs and lets
 *     a future `/api/_internal/telemetry` route surface the numbers.
 *
 * Reset between tests via `resetSpawnTelemetry()` so module-level state
 * doesn't bleed across describe blocks.
 */

import type { AgentId } from "../../shared/types.js";

/**
 * Outcome categories the spawn route can produce. Aligned with the HTTP
 * status codes the route returns: 200 → `success`, 429 with the per-turn
 * suffix → `quota_per_turn`, 429 with the per-parent suffix → `quota_per_parent`,
 * 400 → `invalid_request`, 404 → `parent_missing`, everything else → `error`.
 */
export type SpawnOutcome =
  | "success"
  | "quota_per_turn"
  | "quota_per_parent"
  | "invalid_request"
  | "parent_missing"
  | "error";

export interface SpawnTelemetryRecord {
  /** Parent session id. */
  parentSessionId: string;
  /** Free-form turn id (when supplied by the agent via `--turn`). */
  spawnedByTurn?: string;
  /**
   * Effective agent id for the child — `body.agent ?? defaultAgentId`. We
   * record the *effective* id, not the per-call override, so the counter
   * reflects which CLI actually drives the spawned session.
   */
  agentId: AgentId;
  outcome: SpawnOutcome;
  /** HTTP status the route returned (200 on success, 4xx/5xx on failure). */
  statusCode: number;
  /** Newly-created child id, on success only. */
  childSessionId?: string;
  /** Error message (truncated to 200 chars), on failure only. */
  errorMessage?: string;
}

interface SpawnTelemetryCounters {
  total: number;
  byOutcome: Record<SpawnOutcome, number>;
  byAgent: Partial<Record<AgentId, number>>;
  byTurn: Record<string, number>;
  byParent: Record<string, number>;
}

function emptyCounters(): SpawnTelemetryCounters {
  return {
    total: 0,
    byOutcome: {
      success: 0,
      quota_per_turn: 0,
      quota_per_parent: 0,
      invalid_request: 0,
      parent_missing: 0,
      error: 0,
    },
    byAgent: {},
    byTurn: {},
    byParent: {},
  };
}

let counters: SpawnTelemetryCounters = emptyCounters();

/**
 * Classify a spawn failure into one of the outcome buckets the telemetry
 * surfaces. The status code is the primary signal; the error message
 * disambiguates 429 (per-turn vs per-parent) so the two quotas are countable
 * separately — useful for "is the per-turn cap firing too often?" questions.
 */
export function classifySpawnFailure(
  statusCode: number,
  errorMessage: string,
): Exclude<SpawnOutcome, "success"> {
  if (statusCode === 404) return "parent_missing";
  if (statusCode === 400) return "invalid_request";
  if (statusCode === 429) {
    return errorMessage.toLowerCase().includes("per-turn") ? "quota_per_turn" : "quota_per_parent";
  }
  return "error";
}

/**
 * Record one spawn invocation. Increments the in-process counters and emits
 * a structured `[spawn-telemetry]` log line.
 */
export function recordSpawnInvocation(record: SpawnTelemetryRecord): void {
  counters.total += 1;
  counters.byOutcome[record.outcome] += 1;
  counters.byAgent[record.agentId] = (counters.byAgent[record.agentId] ?? 0) + 1;
  if (record.spawnedByTurn) {
    counters.byTurn[record.spawnedByTurn] = (counters.byTurn[record.spawnedByTurn] ?? 0) + 1;
  }
  counters.byParent[record.parentSessionId] = (counters.byParent[record.parentSessionId] ?? 0) + 1;

  const parts = [
    `outcome=${record.outcome}`,
    `status=${record.statusCode}`,
    `parent=${record.parentSessionId}`,
    `agent=${record.agentId}`,
  ];
  if (record.spawnedByTurn) parts.push(`turn=${record.spawnedByTurn}`);
  if (record.childSessionId) parts.push(`child=${record.childSessionId}`);
  if (record.errorMessage) {
    const truncated = record.errorMessage.slice(0, 200).replace(/\s+/g, " ");
    parts.push(`error="${truncated}"`);
  }
  console.log(`[spawn-telemetry] ${parts.join(" ")}`);
}

/** Read-only view of the in-process counters. */
export function getSpawnTelemetrySnapshot(): SpawnTelemetryCounters {
  return {
    total: counters.total,
    byOutcome: { ...counters.byOutcome },
    byAgent: { ...counters.byAgent },
    byTurn: { ...counters.byTurn },
    byParent: { ...counters.byParent },
  };
}

/** Reset the counters. Used by tests between describe blocks. */
export function resetSpawnTelemetry(): void {
  counters = emptyCounters();
}
