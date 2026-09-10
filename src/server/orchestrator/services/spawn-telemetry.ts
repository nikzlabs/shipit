import type { AgentId } from "../../shared/types.js";

export type SpawnOutcome =
  | "success"
  | "quota_per_turn"
  | "quota_per_parent"
  | "invalid_request"
  | "parent_missing"
  | "error";

export interface SpawnTelemetryRecord {
  parentSessionId: string;
  spawnedByTurn?: string;
  agentId: AgentId;
  outcome: SpawnOutcome;
  statusCode: number;
  childSessionId?: string;
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

export function getSpawnTelemetrySnapshot(): SpawnTelemetryCounters {
  return {
    total: counters.total,
    byOutcome: { ...counters.byOutcome },
    byAgent: { ...counters.byAgent },
    byTurn: { ...counters.byTurn },
    byParent: { ...counters.byParent },
  };
}

export function resetSpawnTelemetry(): void {
  counters = emptyCounters();
}
