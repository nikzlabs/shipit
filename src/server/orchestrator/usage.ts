import type {
  UsageTurn, SessionUsage, UsageStats, TurnUsage, WeeklyUsage, UsageGroup,
} from "../shared/types.js";
import { usageTotalsFrom } from "../shared/types/usage-types.js";
import type { DatabaseManager } from "../shared/database.js";
import type { BillingMode, ModelPrice } from "../shared/catalogue/types.js";
import { costFromRates } from "./turn-attribution.js";

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

// Fill only between recorded weeks; the client chooses the visible time window.
export function fillWeekGaps(buckets: WeeklyUsage[]): WeeklyUsage[] {
  if (buckets.length === 0) return [];
  const byWeek = new Map(buckets.map((b) => [b.week, b]));
  const end = Date.parse(`${buckets[buckets.length - 1].week}T00:00:00Z`);
  const out: WeeklyUsage[] = [];
  for (let t = Date.parse(`${buckets[0].week}T00:00:00Z`); t <= end; t += MS_PER_WEEK) {
    const week = new Date(t).toISOString().slice(0, 10);
    out.push(byWeek.get(week) ?? { week, costUsd: 0, atApiRatesUsd: 0, tokens: 0 });
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
  service_id: string | null;
  billing_mode: string | null;
  rate_input: number | null;
  rate_output: number | null;
  rate_cache_read: number | null;
  rate_cache_write: number | null;
  created_at: string;
}

export type TurnCostSource = "cumulative" | "per-turn";

export interface TurnAttribution {
  serviceId: string;
  billingMode: BillingMode;
  /** Persist the turn's rates; later catalogue edits must not change history. */
  rates: ModelPrice;
}

export interface RecordedTurn {
  costUsd: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreate?: number;
  model?: string;
  /** Last API call's context occupancy, not the turn-wide token sum. */
  contextTokens?: number;
  subAgentId?: string;
  credentialRouteId?: string;
  costSource?: TurnCostSource;
  attribution?: TurnAttribution;
  /** Preserve the harness total across billing-mode changes, even when costUsd has another source. */
  cumulativeSnapshot?: number;
}

export type RecordedTurnExtra = Omit<
  RecordedTurn,
  "costUsd" | "durationMs" | "inputTokens" | "outputTokens"
>;

// Group by persisted rates as well as service/mode so price changes remain distinct.
const SPLIT_COLUMNS = `
  service_id, billing_mode,
  rate_input, rate_output, rate_cache_read, rate_cache_write,
  SUM(cost_usd) AS cost,
  SUM(COALESCE(input_tokens, 0)) AS input_tokens,
  SUM(COALESCE(output_tokens, 0)) AS output_tokens,
  SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
  SUM(COALESCE(cache_create_tokens, 0)) AS cache_create_tokens,
  COUNT(*) AS turns,
  GROUP_CONCAT(DISTINCT model) AS models
`;
const SPLIT_GROUP_BY = `
  GROUP BY service_id, billing_mode, rate_input, rate_output, rate_cache_read, rate_cache_write
`;

interface SplitRow {
  service_id: string | null;
  billing_mode: string | null;
  rate_input: number | null;
  rate_output: number | null;
  rate_cache_read: number | null;
  rate_cache_write: number | null;
  cost: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  turns: number;
  models: string | null;
}

// Includes new rows without attribution, not only historical usage.
export const LEGACY_GROUP_KEY = "legacy";

function foldSplitRows(rows: SplitRow[]): UsageGroup[] {
  const byKey = new Map<string, UsageGroup & { modelSet: Set<string> }>();
  for (const r of rows) {
    const attributed = r.service_id !== null && (r.billing_mode === "sub" || r.billing_mode === "key");
    const billingMode = attributed ? (r.billing_mode as BillingMode) : undefined;
    const key = attributed ? `${r.service_id}:${billingMode}` : LEGACY_GROUP_KEY;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        kind: billingMode ?? "legacy",
        ...(attributed ? { serviceId: r.service_id!, billingMode } : {}),
        models: [],
        modelSet: new Set<string>(),
        turns: 0,
        tokens: 0,
        costUsd: 0,
        atApiRatesUsd: 0,
      };
      byKey.set(key, group);
    }
    group.turns += r.turns;
    group.tokens += r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_create_tokens;
    if (billingMode !== "sub") group.costUsd += r.cost ?? 0;
    if (billingMode === "sub" && r.rate_input !== null) {
      group.atApiRatesUsd += costFromRates(
        {
          input: r.rate_input,
          output: r.rate_output ?? 0,
          cacheRead: r.rate_cache_read ?? 0,
          cacheWrite: r.rate_cache_write ?? 0,
        },
        {
          input: r.input_tokens,
          output: r.output_tokens,
          cacheRead: r.cache_read_tokens,
          cacheWrite: r.cache_create_tokens,
        },
      );
    }
    for (const model of (r.models ?? "").split(",")) {
      if (model !== "") group.modelSet.add(model);
    }
  }
  const rank = { sub: 0, key: 1, legacy: 2 };
  return [...byKey.values()]
    .map(({ modelSet, ...group }) => ({ ...group, models: [...modelSet].sort() }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.key.localeCompare(b.key));
}

export class UsageManager {
  private db;
  private stmtInsert;
  private stmtLastRoute;
  private stmtLastCumulative;
  private stmtSessionUsage;
  private stmtSessionSplit;
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
        rate_input, rate_output, rate_cache_read, rate_cache_write,
        credential_route_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Consults route independently and must not change the session's account notice.
    this.stmtLastRoute = this.db.prepare(`
      SELECT credential_route_id FROM usage_turns
      WHERE session_id = ? AND sub_agent_id IS NULL AND credential_route_id IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `);
    // Each conversation has its own cumulative baseline; NULL identifies the primary agent.
    this.stmtLastCumulative = this.db.prepare(`
      SELECT cumulative_cost_usd FROM usage_turns
      WHERE session_id = ? AND sub_agent_id IS ? AND cumulative_cost_usd IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `);
    this.stmtSessionUsage = this.db.prepare(`
      SELECT SUM(duration_ms) as total_duration, COUNT(*) as turn_count
      FROM usage_turns WHERE session_id = ?
    `);
    this.stmtSessionSplit = this.db.prepare(
      `SELECT ${SPLIT_COLUMNS} FROM usage_turns WHERE session_id = ? ${SPLIT_GROUP_BY}`,
    );
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

  /** Return the persisted per-turn cost so live output matches reloaded history. */
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
    let cumulative: number | null = extra?.cumulativeSnapshot ?? null;
    if (costSource === "cumulative") {
      cumulative = costUsd;
      const prev = this.stmtLastCumulative.get(sessionId, extra?.subAgentId ?? null) as
        | { cumulative_cost_usd: number }
        | undefined;
      const prevCum = prev?.cumulative_cost_usd;
      // A decreased total starts a new chain; charge the current amount rather than a negative delta.
      perTurnCost =
        prevCum !== undefined && cumulative >= prevCum ? cumulative - prevCum : cumulative;
    }
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
      extra?.subAgentId ?? null,
      cumulative,
      attribution?.serviceId ?? null,
      attribution?.billingMode ?? null,
      attribution?.rates.input ?? null,
      attribution?.rates.output ?? null,
      attribution?.rates.cacheRead ?? null,
      attribution?.rates.cacheWrite ?? null,
      extra?.credentialRouteId ?? null,
    );
    return perTurnCost;
  }

  lastTurnCredentialRouteId(sessionId: string): string | undefined {
    const row = this.stmtLastRoute.get(sessionId) as { credential_route_id: string } | undefined;
    return row?.credential_route_id ?? undefined;
  }

  getSessionUsage(sessionId: string): SessionUsage | undefined {
    const row = this.stmtSessionUsage.get(sessionId) as { total_duration: number | null; turn_count: number };

    if (row.turn_count === 0) return undefined;

    const groups = foldSplitRows(this.stmtSessionSplit.all(sessionId) as SplitRow[]);
    return {
      sessionId,
      totalDurationMs: row.total_duration ?? 0,
      turnCount: row.turn_count,
      totals: usageTotalsFrom(groups),
      groups,
    };
  }

  getSessionTokenTotals(sessionId: string): { cumulativeInputTokens: number; cumulativeOutputTokens: number } | undefined {
    const row = this.stmtSessionTokens.get(sessionId) as { input_total: number | null; output_total: number | null; turn_count: number };

    if (row.turn_count === 0) return undefined;
    if (row.input_total === null && row.output_total === null) return undefined;

    return {
      cumulativeInputTokens: row.input_total ?? 0,
      cumulativeOutputTokens: row.output_total ?? 0,
    };
  }

  getSessionTurns(sessionId: string): UsageTurn[] {
    const rows = this.stmtSessionTurns.all(sessionId) as UsageRow[];
    return rows.map((r) => this.fromRow(r));
  }

  getPerTurnUsage(sessionId: string): TurnUsage[] {
    const rows = this.stmtSessionTurns.all(sessionId) as UsageRow[];
    const out: TurnUsage[] = [];
    for (const r of rows) {
      // Consults have separate context windows and must not affect the session dial.
      if (r.sub_agent_id !== null) continue;
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
      applyAttribution(turn, r);
      out.push(turn);
    }
    return out;
  }

  getStats(): UsageStats {
    const perSession = this.db.prepare(`
      SELECT session_id, SUM(duration_ms) as total_duration, ${SPLIT_COLUMNS}
      FROM usage_turns
      ${SPLIT_GROUP_BY.replace("GROUP BY", "GROUP BY session_id,")}
    `).all() as (SplitRow & { session_id: string; total_duration: number | null })[];

    const bySession = new Map<string, { rows: SplitRow[]; durationMs: number; turns: number }>();
    for (const r of perSession) {
      let entry = bySession.get(r.session_id);
      if (!entry) bySession.set(r.session_id, (entry = { rows: [], durationMs: 0, turns: 0 }));
      entry.rows.push(r);
      entry.durationMs += r.total_duration ?? 0;
      entry.turns += r.turns;
    }
    const sessions: SessionUsage[] = [...bySession].map(([sessionId, entry]) => ({
      sessionId,
      totalDurationMs: entry.durationMs,
      turnCount: entry.turns,
      totals: usageTotalsFrom(foldSplitRows(entry.rows)),
    }));

    const groups = foldSplitRows(
      this.db.prepare(`SELECT ${SPLIT_COLUMNS} FROM usage_turns ${SPLIT_GROUP_BY}`).all() as SplitRow[],
    );

    return {
      sessions,
      totals: usageTotalsFrom(groups),
      groups,
      totalTurns: sessions.reduce((n, s) => n + s.turnCount, 0),
      weekly: this.weeklySeries(),
    };
  }

  // Advance to Sunday, then subtract six days to group by UTC Monday.
  private weeklySeries(): WeeklyUsage[] {
    const rows = this.db.prepare(`
      SELECT date(created_at, 'weekday 0', '-6 days') as week, ${SPLIT_COLUMNS}
      FROM usage_turns
      ${SPLIT_GROUP_BY.replace("GROUP BY", "GROUP BY week,")}
      ORDER BY week
    `).all() as (SplitRow & { week: string })[];

    const byWeek = new Map<string, SplitRow[]>();
    for (const r of rows) {
      const bucket = byWeek.get(r.week);
      if (bucket) bucket.push(r);
      else byWeek.set(r.week, [r]);
    }
    return fillWeekGaps(
      [...byWeek].map(([week, weekRows]) => {
        const totals = usageTotalsFrom(foldSplitRows(weekRows));
        return {
          week,
          costUsd: totals.meteredCostUsd,
          atApiRatesUsd: totals.atApiRatesUsd,
          tokens: totals.meteredTokens + totals.includedTokens + totals.legacyTokens,
        };
      }),
    );
  }

  clear(): void {
    this.db.prepare("DELETE FROM usage_turns").run();
  }

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
    applyAttribution(turn, row);
    return turn;
  }
}

function applyAttribution(turn: TurnUsage | UsageTurn, row: UsageRow): void {
  if (row.billing_mode !== "sub" && row.billing_mode !== "key") return;
  turn.billingMode = row.billing_mode;
  if (row.billing_mode !== "sub" || row.rate_input === null) return;
  turn.atApiRatesUsd = costFromRates(
    {
      input: row.rate_input,
      output: row.rate_output ?? 0,
      cacheRead: row.rate_cache_read ?? 0,
      cacheWrite: row.rate_cache_write ?? 0,
    },
    {
      input: row.input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      cacheRead: row.cache_read_tokens ?? 0,
      cacheWrite: row.cache_create_tokens ?? 0,
    },
  );
}
