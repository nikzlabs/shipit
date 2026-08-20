// ---- Usage tracking data types ----

import type { BillingMode } from "../catalogue/types.js";

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
  /** docs/252 req 16 — see {@link TurnUsage.billingMode}. */
  billingMode?: BillingMode;
  /** docs/252 req 16 — see {@link TurnUsage.atApiRatesUsd}. */
  atApiRatesUsd?: number;
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
  /**
   * docs/252 req 16 — how this turn was billed. Absent on a `legacy` row, which
   * predates attribution and cannot be classified after the fact.
   */
  billingMode?: BillingMode;
  /**
   * docs/252 req 16 — what this turn's tokens would have cost at the rates
   * persisted WITH the row. **`sub` rows only**, because that is the only place
   * the requirement puts this figure: for a `key` row the rates ARE the spend,
   * so a second copy under a comparison's name is a number waiting to be summed
   * into the wrong column. Never money spent.
   */
  atApiRatesUsd?: number;
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

/**
 * docs/252 req 16 — one row of the usage split: a `(service, billing mode)`
 * pair, or the single `legacy` bucket for rows recorded before ShipIt tracked
 * attribution.
 *
 * **The column decides the source, keyed on billing mode** (`catalogue.md`,
 * *Pricing*). `costUsd` sums the stored per-turn figure; `atApiRatesUsd`
 * RECOMPUTES from each row's persisted rates and its tokens. Neither reads the
 * other's source, and neither reads the live catalogue — which is what makes a
 * retired model's history still valuable and stops a price edit restating the
 * past.
 */
export type UsageGroupKind = "sub" | "key" | "legacy";

export interface UsageGroup {
  /**
   * `${serviceId}:${billingMode}`, or the literal `"legacy"`. Same string the
   * quota map is keyed by, so a `sub` row can be joined to its indicator
   * without re-deriving anything.
   */
  key: string;
  kind: UsageGroupKind;
  /** Absent on the legacy group — its attribution is exactly what is unknown. */
  serviceId?: string;
  billingMode?: BillingMode;
  /** Distinct model ids seen in this group, sorted. */
  models: string[];
  turns: number;
  /** Input + output + cache reads + cache writes. Volume is tokens, not turns (req 16). */
  tokens: number;
  /**
   * Money. `key`: the summed per-turn figure. `legacy`: its own **unqualified**
   * total, of unknown provenance — carried forward as what the user has already
   * seen and added into no headline. `sub`: always zero; nothing was billed.
   */
  costUsd: number;
  /**
   * Recomputed from the persisted rates. **`sub` groups only** — zero on a
   * `key` group (whose rates are already its spend) and on `legacy` (which has
   * none). Populating it for a `key` group would be a comparison figure sitting
   * beside the spend it duplicates, one careless `reduce` away from doubling
   * the metered total.
   */
  atApiRatesUsd: number;
}

/**
 * The headline figures for a scope, derived from its groups. Three separate
 * numbers because they are three different kinds of thing and summing any two
 * of them is the conflation req 16 exists to end.
 */
export interface UsageTotals {
  /** Money that left the account: `key` groups only. */
  meteredCostUsd: number;
  meteredTurns: number;
  meteredTokens: number;
  /** What `sub` groups would have cost at API rates. A comparison, never money spent. */
  atApiRatesUsd: number;
  includedTurns: number;
  includedTokens: number;
  /** The legacy group's own unqualified total. In neither figure above. */
  legacyCostUsd: number;
  legacyTurns: number;
  legacyTokens: number;
}

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  meteredCostUsd: 0, meteredTurns: 0, meteredTokens: 0,
  atApiRatesUsd: 0, includedTurns: 0, includedTokens: 0,
  legacyCostUsd: 0, legacyTurns: 0, legacyTokens: 0,
};

/** Fold groups into the three headline figures. The only place the split is summed. */
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

/**
 * The ONE dollar figure a compact running surface can show for a session — the
 * context dial's trigger, the modal's per-session "Cost" — and what it means.
 *
 * req 16: a session on a subscription shows its at-API-rates estimate, labelled
 * as such, rather than a blank or a zero. The three figures it can carry:
 *
 *  - `metered` — money left the account this session. The figure that is money.
 *  - `at-api-rates` — plan work, valued at the service's API rates. Rendered
 *    with `≈` and labelled; never presented as money spent.
 *  - `earlier` — only pre-feature rows have a dollar value here. Shown so a
 *    long-lived session does not silently lose a total the user has already
 *    seen; it is not merged into either figure above.
 *
 * **Which one, when a session is MIXED: money first, unless another figure is
 * larger in BOTH dollars and tokens.** Money-first alone read a session's
 * character off a dollar sign rather than off the session: one metered
 * sub-agent consult inside a 39-turn plan session made the dial say `$0.004`
 * while the same popover said `≈$131.58` — under-reporting consumption by four
 * orders of magnitude and defeating the exact purpose req 16 gives these
 * surfaces ("a live sense of what the session is consuming").
 *
 * Requiring BOTH is what makes the override safe, and it is why the rule is not
 * simply "most tokens wins". Volume alone inverts the failure instead of fixing
 * it: an expensive metered model spending $50 over 10K tokens would lose to
 * cheap plan work valued at $2 over 10M, and the dial would under-report *money
 * actually billed* by 25× while labelled "not billed" (cross-backend review,
 * 2026-08-20). Dominance on both axes cannot do that — it fires only when the
 * other side is unambiguously the session's story, so no case comes out worse
 * than it did under money-first.
 *
 * Two consequences worth stating. A totals record carrying no token counts (an
 * older payload, a hand-built fixture) can never satisfy `tokens >` and so
 * behaves exactly as before. And only a candidate with a dollar figure competes
 * at all: legacy volume is unpriced going forward (planning#343), so its tokens
 * must never win a slot it has nothing to show in. Nothing is ever summed — the
 * popover and the usage modal remain where the parts are separated.
 *
 * The legacy bucket also takes forward-generated rows now (req 16,
 * planning#343 — work that resolved no model), so its *volume* is no longer only
 * historical. Those rows are unpriced and add nothing here. `earlier` remains
 * the label for a legacy dollar figure of unknown provenance; it is a statement
 * about what can be said of the money, not a guarantee of when it was spent.
 *
 * `null` when there is nothing to show at all.
 */
export type RunningFigureKind = "metered" | "at-api-rates" | "earlier";

export function sessionRunningFigure(
  totals: UsageTotals,
): { usd: number; kind: RunningFigureKind } | null {
  const all: { usd: number; tokens: number; kind: RunningFigureKind }[] = [
    { usd: totals.meteredCostUsd, tokens: totals.meteredTokens, kind: "metered" },
    { usd: totals.atApiRatesUsd, tokens: totals.includedTokens, kind: "at-api-rates" },
    { usd: totals.legacyCostUsd, tokens: totals.legacyTokens, kind: "earlier" },
  ];
  // Source order IS the money-first priority: metered → estimate → earlier.
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

/**
 * Rank sessions for the modal's "where did it go?" list.
 *
 * Ordered by **the figure each row actually renders** ({@link
 * sessionRunningFigure}), which is the only ordering a reader can verify by
 * looking at the column. An earlier version ranked on `metered + legacy` — a
 * hidden fourth figure that no row shows, so a session displaying $0.10 could
 * outrank one displaying $10.00, and it quietly did the one addition the whole
 * split forbids.
 *
 * The tiebreak is EXPLICIT because under req 16 most sessions are legitimately
 * $0: falling through to tokens, then turns, keeps the tail meaningful, and the
 * final `sessionId` comparison makes the order total so the list does not
 * reshuffle between renders.
 */
export function compareSessionsBySpend(a: SessionUsage, b: SessionUsage): number {
  const shown = (s: SessionUsage) => sessionRunningFigure(s.totals)?.usd ?? 0;
  return (
    shown(b) - shown(a)
    || sessionUsageTokens(b) - sessionUsageTokens(a)
    || b.turnCount - a.turnCount
    || a.sessionId.localeCompare(b.sessionId)
  );
}

/** Every token a session consumed, however it was paid for. */
export function sessionUsageTokens(s: SessionUsage): number {
  return s.totals.meteredTokens + s.totals.includedTokens + s.totals.legacyTokens;
}

export interface SessionUsage {
  sessionId: string;
  totalDurationMs: number;
  turnCount: number;
  /** docs/252 req 16 — replaces the single `totalCostUsd`, which added money to allowance. */
  totals: UsageTotals;
  /**
   * The per-`(service, mode)` breakdown. Only populated for the session the
   * user is looking at (`getSessionUsage`); the all-sessions list carries
   * `totals` alone, since nothing ranks by group.
   */
  groups?: UsageGroup[];
}

/**
 * One calendar week of the trend chart. Three series rather than one, on a
 * toggle — the chart never stacks them, because two segments in one bar
 * carrying two different units invites reading them as parts of a whole.
 */
export interface WeeklyUsage {
  /** Week bucket keyed by its MONDAY as `YYYY-MM-DD` (UTC). */
  week: string;
  /** Metered spend — `key` rows only, matching the headline. Legacy excluded. */
  costUsd: number;
  /** What that week's `sub` rows would have cost at API rates. */
  atApiRatesUsd: number;
  /**
   * Volume, across EVERY row including legacy: a token count is honest whether
   * or not the row can say who billed it. Only the dollar series need the
   * attribution the legacy rows lack.
   */
  tokens: number;
}

export interface UsageStats {
  sessions: SessionUsage[];
  totals: UsageTotals;
  /** The all-sessions split, one row per `(service, mode)` plus the legacy bucket. */
  groups: UsageGroup[];
  totalTurns: number;
  /**
   * Per-week buckets, oldest → newest, for the usage trend chart. Gaps between
   * active weeks are zero-filled so the chart's x-axis stays evenly spaced.
   */
  weekly: WeeklyUsage[];
}

// ---- Usage tracking messages ----

export interface WsUsageStats {
  type: "usage_stats";
  stats: UsageStats;
}

export interface WsUsageUpdate {
  type: "usage_update";
  sessionId: string;
  /** docs/252 req 16 — the split, not a single total. See {@link UsageTotals}. */
  totals: UsageTotals;
  /**
   * The per-`(service, mode)` breakdown, sent live rather than only on
   * `/history`. Without it every turn would replace a hydrated session's split
   * with a totals-only record and the "by service" section would vanish until
   * the next reload; keeping the OLD groups instead would go stale the moment
   * the session changes mode, which is precisely when the split matters.
   */
  groups: UsageGroup[];
  totalDurationMs: number;
  turnCount: number;
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  /**
   * True when this update is attributed to a sub-agent consult (docs/144), not
   * the pinned agent's own turn. The consult's cost and tokens roll into the
   * session bill and cumulative-token totals, but it must NOT move the context
   * dial — the dial tracks the PINNED agent's window occupancy, and a one-shot
   * consult has its own, smaller context. The client skips `setContextTokens`
   * for these. No accompanying `turn_usage_update` is emitted for the same
   * reason (a consult is kept out of the per-turn dial series).
   */
  subAgent?: boolean;
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
  /** Session totals including this turn — the split, per docs/252 req 16. */
  totals: UsageTotals;
  /** Total turns recorded for this session, including this turn. */
  turnCount: number;
}
