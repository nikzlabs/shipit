import type { BillingMode } from "../catalogue/types.js";

export interface UsageTurn {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  timestamp: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreate?: number;
  model?: string;
  /** Last API call's context occupancy, not the turn-wide token sum. */
  contextTokens?: number;
  billingMode?: BillingMode;
  atApiRatesUsd?: number;
}

export interface TurnUsage {
  /** Uncached input only; use turnContextTokens for context occupancy. */
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreate?: number;
  costUsd: number;
  durationMs?: number;
  model?: string;
  timestamp: string;
  /** Last API call's input plus cache; other token fields sum all calls in the turn. */
  contextTokens?: number;
  billingMode?: BillingMode;
  /** Subscription comparison at persisted rates; never money spent. */
  atApiRatesUsd?: number;
}

// Legacy fallback overcounts multi-call turns; prefer the explicit final-call reading.
export function turnContextTokens(
  turn: Pick<TurnUsage, "inputTokens" | "cacheRead" | "cacheCreate" | "contextTokens">,
): number {
  if (turn.contextTokens !== undefined) return turn.contextTokens;
  return turn.inputTokens + (turn.cacheRead ?? 0) + (turn.cacheCreate ?? 0);
}

export type UsageGroupKind = "sub" | "key" | "legacy";

export interface UsageGroup {
  /** serviceId:billingMode, or "legacy". */
  key: string;
  kind: UsageGroupKind;
  serviceId?: string;
  billingMode?: BillingMode;
  models: string[];
  turns: number;
  tokens: number;
  /** Zero for sub; legacy values have unknown provenance and enter no other headline. */
  costUsd: number;
  /** Sub only, recomputed from persisted rates, never the live catalogue. */
  atApiRatesUsd: number;
}

// Keep metered money, subscription comparisons, and legacy values separate; never add them.
export interface UsageTotals {
  meteredCostUsd: number;
  meteredTurns: number;
  meteredTokens: number;
  atApiRatesUsd: number;
  includedTurns: number;
  includedTokens: number;
  legacyCostUsd: number;
  legacyTurns: number;
  legacyTokens: number;
}

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  meteredCostUsd: 0, meteredTurns: 0, meteredTokens: 0,
  atApiRatesUsd: 0, includedTurns: 0, includedTokens: 0,
  legacyCostUsd: 0, legacyTurns: 0, legacyTokens: 0,
};

export function usageTotalsFrom(groups: readonly UsageGroup[]): UsageTotals {
  const out: UsageTotals = { ...EMPTY_USAGE_TOTALS };
  for (const g of groups) {
    if (g.kind === "key") {
      out.meteredCostUsd += g.costUsd;
      out.meteredTurns += g.turns;
      out.meteredTokens += g.tokens;
    } else if (g.kind === "sub") {
      out.atApiRatesUsd += g.atApiRatesUsd;
      out.includedTurns += g.turns;
      out.includedTokens += g.tokens;
    } else {
      out.legacyCostUsd += g.costUsd;
      out.legacyTurns += g.turns;
      out.legacyTokens += g.tokens;
    }
  }
  return out;
}

export type RunningFigureKind = "metered" | "at-api-rates" | "earlier";

export function sessionRunningFigure(
  totals: UsageTotals,
): { usd: number; kind: RunningFigureKind } | null {
  const all: { usd: number; tokens: number; kind: RunningFigureKind }[] = [
    { usd: totals.meteredCostUsd, tokens: totals.meteredTokens, kind: "metered" },
    { usd: totals.atApiRatesUsd, tokens: totals.includedTokens, kind: "at-api-rates" },
    { usd: totals.legacyCostUsd, tokens: totals.legacyTokens, kind: "earlier" },
  ];
  // Prefer money unless another priced bucket exceeds it in both dollars and tokens.
  const candidates = all.filter((c) => c.usd > 0);
  if (candidates.length === 0) return null;
  const lead = candidates[0];
  const dominant = candidates
    .slice(1)
    .filter((c) => c.usd > lead.usd && c.tokens > lead.tokens)
    .sort((a, b) => b.tokens - a.tokens)[0];
  const winner = dominant ?? lead;
  return { usd: winner.usd, kind: winner.kind };
}

// Sort by the displayed figure, with stable tie-breaks for zero-cost sessions.
export function compareSessionsBySpend(a: SessionUsage, b: SessionUsage): number {
  const shown = (s: SessionUsage) => sessionRunningFigure(s.totals)?.usd ?? 0;
  return (
    shown(b) - shown(a)
    || sessionUsageTokens(b) - sessionUsageTokens(a)
    || b.turnCount - a.turnCount
    || a.sessionId.localeCompare(b.sessionId)
  );
}

export function sessionUsageTokens(s: SessionUsage): number {
  return s.totals.meteredTokens + s.totals.includedTokens + s.totals.legacyTokens;
}

export interface SessionUsage {
  sessionId: string;
  totalDurationMs: number;
  turnCount: number;
  totals: UsageTotals;
  groups?: UsageGroup[];
}

export interface WeeklyUsage {
  /** Monday, YYYY-MM-DD in UTC. */
  week: string;
  costUsd: number;
  atApiRatesUsd: number;
  tokens: number;
}

export interface UsageStats {
  sessions: SessionUsage[];
  totals: UsageTotals;
  groups: UsageGroup[];
  totalTurns: number;
  /** Oldest first; inactive weeks are zero-filled. */
  weekly: WeeklyUsage[];
}

export interface WsUsageStats {
  type: "usage_stats";
  stats: UsageStats;
}

export interface WsUsageUpdate {
  type: "usage_update";
  sessionId: string;
  totals: UsageTotals;
  groups: UsageGroup[];
  totalDurationMs: number;
  turnCount: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  subAgent?: boolean;
}

/** Updates the context dial; session-cumulative usage_update does not. */
export interface WsTurnUsageUpdate {
  type: "turn_usage_update";
  sessionId: string;
  turn: TurnUsage;
  totals: UsageTotals;
  turnCount: number;
}
