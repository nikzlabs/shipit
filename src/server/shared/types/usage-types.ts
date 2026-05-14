// ---- Usage tracking data types ----

export interface UsageTurn {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  timestamp: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens read from the prompt cache for this turn. */
  cacheRead?: number;
  /** Tokens written to the prompt cache for this turn. */
  cacheCreate?: number;
  /** Model identifier responsible for this turn. */
  model?: string;
}

/**
 * Per-turn usage delta — emitted in `turn_usage_update` and persisted on
 * each `MessageGroup` so the client can render a per-turn breakdown without
 * recomputing it from cumulative session totals.
 *
 * NOTE: `inputTokens` is *only the uncached* input for this turn. With prompt
 * caching enabled (the default for Claude Code), the bulk of the conversation
 * is billed as `cacheRead` / `cacheCreate`, not `inputTokens` — so a turn can
 * report `inputTokens: 4` while actually occupying ~70K of context. To get the
 * real context-window occupancy, use `turnContextTokens()` below, which sums
 * all three. Never treat `inputTokens` alone as "context size".
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreate?: number;
  costUsd: number;
  durationMs?: number;
  model?: string;
  /** ISO timestamp recorded when the turn finished. */
  timestamp: string;
}

/**
 * The real context-window occupancy for a turn: uncached input + cache reads +
 * cache writes. This is the number that should drive the context dial, the
 * status-bar meter, and the usage modal's "Context" reading — `inputTokens`
 * alone undercounts massively when prompt caching is active.
 */
export function turnContextTokens(turn: Pick<TurnUsage, "inputTokens" | "cacheRead" | "cacheCreate">): number {
  return turn.inputTokens + (turn.cacheRead ?? 0) + (turn.cacheCreate ?? 0);
}

export interface SessionUsage {
  sessionId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
}

export interface UsageStats {
  sessions: SessionUsage[];
  totalCostUsd: number;
  totalTurns: number;
}

// ---- Usage tracking messages ----

export interface WsUsageStats {
  type: "usage_stats";
  stats: UsageStats;
}

export interface WsUsageUpdate {
  type: "usage_update";
  sessionId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
}

/**
 * Per-turn usage update — emitted at the end of every agent turn so the
 * "context dial" UI can update with a precise per-turn breakdown.
 *
 * Distinct from `usage_update` (which carries session-cumulative totals)
 * because the dial needs to render the per-turn delta — input vs output
 * vs cache reads — without losing fidelity to round-tripped sums.
 */
export interface WsTurnUsageUpdate {
  type: "turn_usage_update";
  sessionId: string;
  turn: TurnUsage;
  /** Total cost across all turns for this session, including this turn. */
  totalCostUsd: number;
  /** Total turns recorded for this session, including this turn. */
  turnCount: number;
}
