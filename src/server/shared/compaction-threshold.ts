import { turnContextTokens, type TurnUsage } from "./types/usage-types.js";

/**
 * The one minimum for every compaction ShipIt starts by itself: after a merge
 * (docs/295-compact-context-on-merge req 15), at the agent's request
 * (docs/324-agent-requested-compaction req 12) and when idle (docs/333-idle-compaction req 6).
 * Under it, only a compaction the user asks for runs: their `/compact`, or one they ask the
 * agent for (docs/324-agent-requested-compaction req 13).
 */
export const AUTOMATIC_COMPACTION_MIN_CONTEXT_TOKENS = 200_000;

type ContextReading = Pick<TurnUsage, "inputTokens" | "cacheRead" | "cacheCreate" | "contextTokens" | "timestamp">;

/**
 * The context size now, as well as it is known: the last turn that read one. A compaction turn
 * reads none — it reports zero usage (Claude, Grok) or no usage (OpenCode) — so a compaction
 * newer than that reading answers with its own `postTokens`, and with 0 where the harness gives
 * none: just compacted is small. The server and the client's prediction both read this.
 */
export function latestContextTokens(
  turns: readonly ContextReading[],
  lastCompaction?: { createdAt: string; postTokens?: number },
): number | undefined {
  let reading: ContextReading | undefined;
  for (let i = turns.length - 1; i >= 0 && !reading; i--) {
    if (turnContextTokens(turns[i]) > 0) reading = turns[i];
  }
  if (lastCompaction && (!reading || Date.parse(lastCompaction.createdAt) > usageRowTime(reading.timestamp))) {
    return lastCompaction.postTokens ?? 0;
  }
  return reading ? turnContextTokens(reading) : undefined;
}

/** A usage row's `created_at` is SQLite's `datetime('now')`: UTC, with a space and no zone. */
function usageRowTime(createdAt: string): number {
  return Date.parse(createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`);
}
