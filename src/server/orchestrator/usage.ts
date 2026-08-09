import type { UsageTurn, SessionUsage, UsageStats, TurnUsage, WeeklyUsage } from "../shared/types.js";
import type { DatabaseManager } from "../shared/database.js";
import type { BillingMode, ModelPrice } from "../shared/catalogue/types.js";

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Zero-fill the weeks between the first and last active bucket so the trend
 * chart's x-axis is evenly spaced — a quiet week must render as an empty column,
 * not silently collapse the axis (which would make two adjacent bars look like
 * consecutive weeks when they aren't).
 *
 * Deliberately bounded by the DATA, not by "now": extending the series to the
 * current week would make `getStats()` depend on the wall clock. The client
 * windows this to the most recent N weeks that fit its chart.
 */
export function fillWeekGaps(buckets: WeeklyUsage[]): WeeklyUsage[] {
  if (buckets.length === 0) return [];
  const byWeek = new Map(buckets.map((b) => [b.week, b]));
  const end = Date.parse(`${buckets[buckets.length - 1].week}T00:00:00Z`);
  const out: WeeklyUsage[] = [];
  for (let t = Date.parse(`${buckets[0].week}T00:00:00Z`); t <= end; t += MS_PER_WEEK) {
    const week = new Date(t).toISOString().slice(0, 10);
    out.push(byWeek.get(week) ?? { week, costUsd: 0, turns: 0 });
  }
  return out;
}

interface UsageRow {
  id: number;
  session_id: string;
  cost_usd: number;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_create_tokens: number | null;
  model: string | null;
  context_tokens: number | null;
  sub_agent_id: string | null;
  cumulative_cost_usd: number | null;
  // docs/252 req 16 — attribution. All six are null together (a `legacy` row) or
  // present together; the table's CHECK constraint is what makes that true.
  service_id: string | null;
  billing_mode: string | null;
  rate_input: number | null;
  rate_output: number | null;
  rate_cache_read: number | null;
  rate_cache_write: number | null;
  created_at: string;
}

/**
 * Where a turn's `costUsd` came from — which is what decides whether it still
 * needs the cumulative-to-delta conversion, and the column cannot say.
 *
 * - `cumulative` — a harness's running conversation total (Claude Code's
 *   `total_cost_usd`). `record()` diffs it against the session's previous
 *   snapshot to get this turn's cost.
 * - `per-turn` — already this turn's own cost, from whatever computed it (a
 *   one-shot sub-agent consult's reported run cost; from phase 3 on, a figure
 *   derived from the catalogue's persisted rates). Stored verbatim.
 *
 * Branching on the *source* rather than on `subAgentId` is the fix docs/252
 * phase 3 requires: "not a sub-agent implies cumulative" holds only while the
 * sole producer is Claude on Anthropic, and delta'ing an already-per-turn
 * figure yields the difference between two consecutive turns.
 */
export type TurnCostSource = "cumulative" | "per-turn";

/**
 * docs/252 req 16 — who billed a turn, and at what rates.
 *
 * A single object rather than six loose fields, so the all-or-nothing rule holds
 * in the type system as well as in SQL: there is no such thing as a row that
 * knows its service but not what it was charged, and historical attribution
 * cannot be reconstructed afterwards, so a half-row is unrecoverable.
 */
export interface TurnAttribution {
  serviceId: string;
  billingMode: BillingMode;
  /**
   * The catalogue's unit rates **at the time of the turn**, persisted rather
   * than looked up later: a price edit must not restate history, and a retired
   * model has no live price to look up at all (catalogue.md, Pricing).
   */
  rates: ModelPrice;
}

/** Inputs for a single recorded turn. */
export interface RecordedTurn {
  costUsd: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreate?: number;
  model?: string;
  /**
   * Real context occupancy at turn end (last API iteration's input + cache).
   * Distinct from the turn-wide cache sums, which over-count for multi-call
   * tool-use turns. See `TurnUsage.contextTokens` doc.
   */
  contextTokens?: number;
  /** docs/144 — set when the turn was a sub-agent consult rather than the pinned agent's own. */
  subAgentId?: string;
  /**
   * Defaults to today's behaviour — `per-turn` for a sub-agent consult,
   * `cumulative` otherwise — so a caller that does not know still gets what it
   * got before.
   */
  costSource?: TurnCostSource;
  /** Absent = a `legacy` row: written before ShipIt tracked where money went. */
  attribution?: TurnAttribution;
}

/** The trailing bag of `record()` — everything `RecordedTurn` holds that the positional parameters don't. */
export type RecordedTurnExtra = Omit<
  RecordedTurn,
  "costUsd" | "durationMs" | "inputTokens" | "outputTokens"
>;

export class UsageManager {
  private db;
  private stmtInsert;
  private stmtLastCumulative;
  private stmtSessionUsage;
  private stmtSessionTokens;
  private stmtSessionTurns;
  private stmtDeleteBySession;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
    this.stmtInsert = this.db.prepare(`
      INSERT INTO usage_turns (
        session_id, cost_usd, duration_ms,
        input_tokens, output_tokens,
        cache_read_tokens, cache_create_tokens, model, context_tokens,
        sub_agent_id, cumulative_cost_usd,
        service_id, billing_mode,
        rate_input, rate_output, rate_cache_read, rate_cache_write
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Most recent cumulative snapshot for ONE agent's turns within a session,
    // used to diff a running total into a per-turn delta. The chain is keyed by
    // `(session, sub_agent_id)` because a resume chain belongs to one
    // conversation: the primary agent's chain is the `sub_agent_id IS NULL` one,
    // so a consult still can't perturb it — that guarantee is unchanged, just
    // stated as a key rather than as an exclusion. Binding NULL through `IS ?`
    // reproduces the previous `IS NULL` clause exactly for every primary turn.
    //
    // Keyed rather than primary-only because docs/252's cost-source
    // discriminator makes a cumulative CONSULT expressible, where `subAgentId`
    // previously made it unreachable. Under the old exclusion such a row would
    // have been diffed against the PRIMARY agent's unrelated running total,
    // which is a wrong number rather than a missing one.
    this.stmtLastCumulative = this.db.prepare(`
      SELECT cumulative_cost_usd FROM usage_turns
      WHERE session_id = ? AND sub_agent_id IS ? AND cumulative_cost_usd IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `);
    this.stmtSessionUsage = this.db.prepare(`
      SELECT SUM(cost_usd) as total_cost, SUM(duration_ms) as total_duration, COUNT(*) as turn_count
      FROM usage_turns WHERE session_id = ?
    `);
    this.stmtSessionTokens = this.db.prepare(`
      SELECT SUM(input_tokens) as input_total, SUM(output_tokens) as output_total,
             COUNT(*) as turn_count
      FROM usage_turns WHERE session_id = ?
    `);
    this.stmtSessionTurns = this.db.prepare(
      "SELECT * FROM usage_turns WHERE session_id = ? ORDER BY id",
    );
    this.stmtDeleteBySession = this.db.prepare(
      "DELETE FROM usage_turns WHERE session_id = ?",
    );
  }

  /**
   * Record a turn's cost, duration, optional token counts (input/output),
   * cache breakdown, and the model that produced the turn.
   *
   * Backwards-compatible with the previous positional signature so existing
   * callers continue to work; new fields can be supplied via the trailing
   * `extra` object.
   *
   * Cost semantics — IMPORTANT: a `cumulative` cost (`extra.costSource`, which
   * is what a harness's `total_cost_usd` is) is the running total of the entire
   * resumed conversation, NOT this turn's cost. We convert it into a per-turn
   * delta here (`max(0, current - previous)`), storing the delta in `cost_usd`
   * and the raw cumulative in `cumulative_cost_usd` so the next turn can diff
   * against it. A reset (the CLI's running total drops because the resume chain
   * broke — e.g. a container re-clone started a fresh conversation) shows up as
   * `current < previous`, which the `max(0, …)` collapses to treating `current`
   * as a new baseline. SUM(cost_usd) is then the true session bill instead of a
   * sum of cumulative snapshots (which over-counted ~N× for N resume chains).
   *
   * A `per-turn` cost is already this turn's own and is stored verbatim, with a
   * null cumulative so it never becomes a baseline the next cumulative turn
   * diffs against. Sub-agent turns (`extra.subAgentId` set) are one-shot
   * consults that report a per-run cost, so that is what they default to.
   *
   * The default reproduces the historical rule exactly — sub-agent ⇒ per-turn,
   * everything else ⇒ cumulative — but the rule itself is only true while the
   * sole producer is a harness billing its own vendor. A caller with a
   * rate-derived figure says so; see {@link TurnCostSource}.
   *
   * The delta chain is keyed by `(session, subAgentId)`, because a running total
   * belongs to one conversation. The primary agent's chain is the one with no
   * sub-agent, so a consult still never perturbs it; and a consult that does
   * report a running total diffs against its OWN previous snapshot rather than
   * against the primary agent's unrelated one.
   *
   * Returns the per-turn cost actually persisted (the delta for a cumulative
   * turn, the verbatim value otherwise), so the live emit can show the same
   * figure the DB will rehydrate instead of the cumulative snapshot.
   */
  record(
    sessionId: string,
    costUsd: number,
    durationMs: number,
    inputTokens?: number,
    outputTokens?: number,
    extra?: RecordedTurnExtra,
  ): number {
    const costSource: TurnCostSource =
      extra?.costSource ?? (extra?.subAgentId !== undefined ? "per-turn" : "cumulative");
    let perTurnCost = costUsd;
    let cumulative: number | null = null;
    if (costSource === "cumulative") {
      cumulative = costUsd;
      const prev = this.stmtLastCumulative.get(sessionId, extra?.subAgentId ?? null) as
        | { cumulative_cost_usd: number }
        | undefined;
      const prevCum = prev?.cumulative_cost_usd;
      // First primary turn of a chain (no prior cumulative) OR a reset
      // (current < previous) → `current` is itself the per-turn cost. Otherwise
      // the delta is current minus the prior running total.
      perTurnCost =
        prevCum !== undefined && cumulative >= prevCum ? cumulative - prevCum : cumulative;
    }
    // All six or none — the CHECK constraint rejects anything else. Absent is
    // the `legacy` bucket, which needs no discriminator of its own.
    const attribution = extra?.attribution;
    this.stmtInsert.run(
      sessionId,
      perTurnCost,
      durationMs,
      inputTokens ?? null,
      outputTokens ?? null,
      extra?.cacheRead ?? null,
      extra?.cacheCreate ?? null,
      extra?.model ?? null,
      extra?.contextTokens ?? null,
      // docs/144 — attribute to the sub-agent when the turn was a spawn.
      extra?.subAgentId ?? null,
      cumulative,
      attribution?.serviceId ?? null,
      attribution?.billingMode ?? null,
      attribution?.rates.input ?? null,
      attribution?.rates.output ?? null,
      attribution?.rates.cacheRead ?? null,
      attribution?.rates.cacheWrite ?? null,
    );
    return perTurnCost;
  }

  /** Get aggregated usage for a single session. */
  getSessionUsage(sessionId: string): SessionUsage | undefined {
    const row = this.stmtSessionUsage.get(sessionId) as { total_cost: number | null; total_duration: number | null; turn_count: number };

    if (row.turn_count === 0) return undefined;

    return {
      sessionId,
      totalCostUsd: row.total_cost ?? 0,
      totalDurationMs: row.total_duration ?? 0,
      turnCount: row.turn_count,
    };
  }

  /** Get cumulative token totals for a session. */
  getSessionTokenTotals(sessionId: string): { cumulativeInputTokens: number; cumulativeOutputTokens: number } | undefined {
    const row = this.stmtSessionTokens.get(sessionId) as { input_total: number | null; output_total: number | null; turn_count: number };

    if (row.turn_count === 0) return undefined;
    if (row.input_total === null && row.output_total === null) return undefined;

    return {
      cumulativeInputTokens: row.input_total ?? 0,
      cumulativeOutputTokens: row.output_total ?? 0,
    };
  }

  /** Get per-turn usage data for a session (for the usage modal breakdown). */
  getSessionTurns(sessionId: string): UsageTurn[] {
    const rows = this.stmtSessionTurns.all(sessionId) as UsageRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * Get per-turn breakdown shaped for the context-dial UI (105). Skips turns
   * that lack token data — those entries can't meaningfully populate the
   * dial.
   */
  getPerTurnUsage(sessionId: string): TurnUsage[] {
    const rows = this.stmtSessionTurns.all(sessionId) as UsageRow[];
    const out: TurnUsage[] = [];
    for (const r of rows) {
      // The dial tracks the PINNED agent's per-turn context occupancy; a
      // sub-agent consult (docs/144) has its own, smaller window and must not
      // appear in the series the dial reads its "current context" from. (Before
      // these turns carried tokens they were already excluded by the token gate
      // below; this keeps that behavior now that they do.)
      if (r.sub_agent_id !== null) continue;
      // The dial needs at least one of input/output tokens to be useful.
      if (r.input_tokens === null && r.output_tokens === null) continue;
      const turn: TurnUsage = {
        inputTokens: r.input_tokens ?? 0,
        outputTokens: r.output_tokens ?? 0,
        costUsd: r.cost_usd,
        durationMs: r.duration_ms,
        timestamp: r.created_at,
      };
      if (r.cache_read_tokens !== null) turn.cacheRead = r.cache_read_tokens;
      if (r.cache_create_tokens !== null) turn.cacheCreate = r.cache_create_tokens;
      if (r.model !== null) turn.model = r.model;
      if (r.context_tokens !== null) turn.contextTokens = r.context_tokens;
      out.push(turn);
    }
    return out;
  }

  /** Get aggregated usage across all sessions. */
  getStats(): UsageStats {
    const sessionRows = this.db.prepare(`
      SELECT session_id, SUM(cost_usd) as total_cost, SUM(duration_ms) as total_duration, COUNT(*) as turn_count
      FROM usage_turns GROUP BY session_id
    `).all() as { session_id: string; total_cost: number; total_duration: number; turn_count: number }[];

    const sessions: SessionUsage[] = sessionRows.map((r) => ({
      sessionId: r.session_id,
      totalCostUsd: r.total_cost,
      totalDurationMs: r.total_duration,
      turnCount: r.turn_count,
    }));

    const totalRow = this.db.prepare(
      "SELECT SUM(cost_usd) as total_cost, COUNT(*) as total_turns FROM usage_turns",
    ).get() as { total_cost: number | null; total_turns: number };

    // Per-week buckets for the trend chart. `created_at` is a UTC timestamp;
    // `date(x, 'weekday 0', '-6 days')` snaps it to that week's MONDAY (advance
    // to the coming Sunday, step back six days), giving stable `YYYY-MM-DD`
    // keys, oldest → newest.
    const weeklyRows = this.db.prepare(`
      SELECT date(created_at, 'weekday 0', '-6 days') as week,
             SUM(cost_usd) as total_cost, COUNT(*) as turns
      FROM usage_turns
      GROUP BY week ORDER BY week
    `).all() as { week: string; total_cost: number | null; turns: number }[];

    const weekly = fillWeekGaps(
      weeklyRows.map((r) => ({
        week: r.week,
        costUsd: r.total_cost ?? 0,
        turns: r.turns,
      })),
    );

    return {
      sessions,
      totalCostUsd: totalRow.total_cost ?? 0,
      totalTurns: totalRow.total_turns,
      weekly,
    };
  }

  /** Clear all usage data. */
  clear(): void {
    this.db.prepare("DELETE FROM usage_turns").run();
  }

  /** Delete all usage data for a session. */
  delete(sessionId: string): boolean {
    const result = this.stmtDeleteBySession.run(sessionId);
    return result.changes > 0;
  }

  private fromRow(row: UsageRow): UsageTurn {
    const turn: UsageTurn = {
      sessionId: row.session_id,
      costUsd: row.cost_usd,
      durationMs: row.duration_ms,
      timestamp: row.created_at,
    };
    if (row.input_tokens !== null) turn.inputTokens = row.input_tokens;
    if (row.output_tokens !== null) turn.outputTokens = row.output_tokens;
    if (row.cache_read_tokens !== null) turn.cacheRead = row.cache_read_tokens;
    if (row.cache_create_tokens !== null) turn.cacheCreate = row.cache_create_tokens;
    if (row.model !== null) turn.model = row.model;
    if (row.context_tokens !== null) turn.contextTokens = row.context_tokens;
    return turn;
  }
}
