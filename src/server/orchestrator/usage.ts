import type { UsageTurn, SessionUsage, UsageStats, TurnUsage } from "../shared/types.js";
import type { DatabaseManager } from "../shared/database.js";

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
  created_at: string;
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
}

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
        sub_agent_id, cumulative_cost_usd
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Most recent cumulative snapshot for a session's PRIMARY-agent turns, used
    // to diff the CLI's running total into a per-turn delta. Sub-agent rows
    // carry a null cumulative and are excluded so a consult can't perturb the
    // primary resume chain's baseline.
    this.stmtLastCumulative = this.db.prepare(`
      SELECT cumulative_cost_usd FROM usage_turns
      WHERE session_id = ? AND sub_agent_id IS NULL AND cumulative_cost_usd IS NOT NULL
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
   * Cost semantics — IMPORTANT: for a PRIMARY-agent turn, `costUsd` is the
   * CLI's `total_cost_usd`, which is the running total of the entire resumed
   * conversation, NOT this turn's cost. We convert it into a per-turn delta
   * here (`max(0, current - previous)`), storing the delta in `cost_usd` and
   * the raw cumulative in `cumulative_cost_usd` so the next turn can diff
   * against it. A reset (the CLI's running total drops because the resume chain
   * broke — e.g. a container re-clone started a fresh conversation) shows up as
   * `current < previous`, which the `max(0, …)` collapses to treating `current`
   * as a new baseline. SUM(cost_usd) is then the true session bill instead of a
   * sum of cumulative snapshots (which over-counted ~N× for N resume chains).
   *
   * Sub-agent turns (`extra.subAgentId` set) are one-shot consults that already
   * report a per-run cost, so they're stored verbatim with a null cumulative
   * and never participate in the primary chain's delta baseline.
   *
   * Returns the per-turn cost actually persisted (the delta for a primary turn,
   * the verbatim value for a sub-agent), so the live emit can show the same
   * figure the DB will rehydrate instead of the cumulative snapshot.
   */
  record(
    sessionId: string,
    costUsd: number,
    durationMs: number,
    inputTokens?: number,
    outputTokens?: number,
    extra?: { cacheRead?: number; cacheCreate?: number; model?: string; contextTokens?: number; subAgentId?: string },
  ): number {
    const isSubAgent = extra?.subAgentId !== undefined;
    let perTurnCost = costUsd;
    let cumulative: number | null = null;
    if (!isSubAgent) {
      cumulative = costUsd;
      const prev = this.stmtLastCumulative.get(sessionId) as
        | { cumulative_cost_usd: number }
        | undefined;
      const prevCum = prev?.cumulative_cost_usd;
      // First primary turn of a chain (no prior cumulative) OR a reset
      // (current < previous) → `current` is itself the per-turn cost. Otherwise
      // the delta is current minus the prior running total.
      perTurnCost =
        prevCum !== undefined && cumulative >= prevCum ? cumulative - prevCum : cumulative;
    }
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

    return {
      sessions,
      totalCostUsd: totalRow.total_cost ?? 0,
      totalTurns: totalRow.total_turns,
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
