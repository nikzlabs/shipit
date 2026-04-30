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
 * `inputTokens` is the *current context size* at the moment this turn ran:
 * Claude re-reads the entire conversation each turn, so the input_tokens
 * count is effectively "what's currently in the model's context window".
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
