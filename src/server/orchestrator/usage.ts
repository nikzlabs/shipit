import type { UsageTurn, SessionUsage, UsageStats } from "../shared/types.js";
import type { DatabaseManager } from "../shared/database.js";

interface UsageRow {
  id: number;
  session_id: string;
  cost_usd: number;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export class UsageManager {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  /** Record a turn's cost, duration, and optional token counts. */
  record(sessionId: string, costUsd: number, durationMs: number, inputTokens?: number, outputTokens?: number): void {
    this.db.prepare(`
      INSERT INTO usage_turns (session_id, cost_usd, duration_ms, input_tokens, output_tokens)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, costUsd, durationMs, inputTokens ?? null, outputTokens ?? null);
  }

  /** Get aggregated usage for a single session. */
  getSessionUsage(sessionId: string): SessionUsage | undefined {
    const row = this.db.prepare(`
      SELECT SUM(cost_usd) as total_cost, SUM(duration_ms) as total_duration, COUNT(*) as turn_count
      FROM usage_turns WHERE session_id = ?
    `).get(sessionId) as { total_cost: number | null; total_duration: number | null; turn_count: number };

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
    const row = this.db.prepare(`
      SELECT SUM(input_tokens) as input_total, SUM(output_tokens) as output_total,
             COUNT(*) as turn_count
      FROM usage_turns WHERE session_id = ?
    `).get(sessionId) as { input_total: number | null; output_total: number | null; turn_count: number };

    if (row.turn_count === 0) return undefined;
    if (row.input_total === null && row.output_total === null) return undefined;

    return {
      cumulativeInputTokens: row.input_total ?? 0,
      cumulativeOutputTokens: row.output_total ?? 0,
    };
  }

  /** Get per-turn usage data for a session (for the usage modal breakdown). */
  getSessionTurns(sessionId: string): UsageTurn[] {
    const rows = this.db.prepare(
      "SELECT * FROM usage_turns WHERE session_id = ? ORDER BY id",
    ).all(sessionId) as UsageRow[];

    return rows.map((r) => this.fromRow(r));
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
    const result = this.db.prepare(
      "DELETE FROM usage_turns WHERE session_id = ?",
    ).run(sessionId);
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
    return turn;
  }
}
