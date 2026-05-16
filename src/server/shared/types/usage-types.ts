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
  /**
   * Real context-window occupancy at turn end (last API call's input + cache
   * reads + cache writes). Distinct from `inputTokens + cacheRead + cacheCreate`,
   * which sums across every API call and dramatically overstates context for
   * tool-heavy multi-call turns. Undefined for turns recorded before the per-
   * iteration breakdown was wired up — callers fall back to the sum.
   */
  contextTokens?: number;
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
  /**
   * Real context-window occupancy at turn end (= last API call's input +
   * cache_read + cache_create from `result.usage.iterations[]`). The fields
   * above are turn-wide SUMS across every API call, so for a tool-heavy turn
   * with N iterations they over-count context by ~N×. This field is the
   * authoritative "current context size" reading. Undefined for turns
   * recorded before the per-iteration plumbing landed — callers fall back
   * to `turnContextTokens()`.
   */
  contextTokens?: number;
}

/**
 * The real context-window occupancy for a turn. Prefers the explicit
 * `contextTokens` field (last API call's input + cache) when present —
 * that's the only correct value for tool-heavy multi-call turns. Falls
 * back to `inputTokens + cacheRead + cacheCreate` for turns recorded
 * before the per-iteration breakdown was wired up; that sum is correct
 * for single-call turns but over-counts N× for N-iteration turns.
 */
export function turnContextTokens(
  turn: Pick<TurnUsage, "inputTokens" | "cacheRead" | "cacheCreate" | "contextTokens">,
): number {
  if (turn.contextTokens !== undefined) return turn.contextTokens;
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
