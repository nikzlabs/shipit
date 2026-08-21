import type {
  UsageTurn, SessionUsage, UsageStats, TurnUsage, WeeklyUsage, UsageGroup,
} from "../shared/types.js";
import { usageTotalsFrom } from "../shared/types/usage-types.js";
import type { DatabaseManager } from "../shared/database.js";
import type { BillingMode, ModelPrice } from "../shared/catalogue/types.js";
import { costFromRates } from "./turn-attribution.js";

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
   * docs/260 §5 — the credential route (account or stored string credential)
   * this turn authenticated with. Independent of `attribution`'s all-or-none
   * rule: a turn can know its route without rates (and vice versa). Absent for
   * env-delivered credentials and legacy rows.
   */
  credentialRouteId?: string;
  /**
   * Defaults to today's behaviour — `per-turn` for a sub-agent consult,
   * `cumulative` otherwise — so a caller that does not know still gets what it
   * got before.
   */
  costSource?: TurnCostSource;
  /**
   * Absent = a `legacy` row: nothing records where this usage went. Written
   * before ShipIt tracked it, or — since planning#343 — written now by work
   * that genuinely resolved no model, which is the same absence reached from
   * the other direction.
   */
  attribution?: TurnAttribution;
  /**
   * docs/252 phase 3 — the harness's running conversation total, when it
   * reported one, on a turn whose `cost_usd` did **not** come from it.
   *
   * Without this the delta chain breaks the moment a session's turns stop
   * sourcing their cost from the harness. A session on a subscription records
   * `cost_usd: 0` and, under the plain rule, no snapshot at all; switch it to
   * the same service's metered key and the first key turn finds no prior
   * cumulative, so the CLI's running total — which still covers every earlier
   * subscription turn of the same resumed conversation — is recorded as that one
   * turn's cost. The chain is about continuity of the harness's own number, so
   * the snapshot is stored whenever that number exists, independently of which
   * figure the column took.
   */
  cumulativeSnapshot?: number;
}

/** The trailing bag of `record()` — everything `RecordedTurn` holds that the positional parameters don't. */
export type RecordedTurnExtra = Omit<
  RecordedTurn,
  "costUsd" | "durationMs" | "inputTokens" | "outputTokens"
>;

/**
 * docs/252 req 16 — the split aggregation, grouped by `(service, mode)` AND by
 * the rate set the rows carry.
 *
 * The rates are in the GROUP BY on purpose: "at API rates" recomputes from each
 * row's **persisted** rates, and a `(service, mode)` pair accumulates several
 * rate sets over time (different models, and the same model after a price
 * edit). Grouping by them lets one `costFromRates` call price a whole bucket,
 * so the formula stays in one place instead of being re-expressed in SQL —
 * while still never consulting the live catalogue.
 *
 * Legacy rows have all six attribution columns NULL together (the table's
 * `CHECK`), and SQLite groups NULLs as equal, so they fall into exactly one
 * bucket with no rate set at all.
 */
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

/**
 * The literal key of the one bucket for rows that carry no attribution.
 *
 * Named for its founding case — rows recorded before attribution existed — but
 * it is **not** purely historical and does not drain on its own (req 16,
 * planning#343). Work that resolves no model writes into it going forward: the
 * unknown is what defines the bucket, not when the row was written.
 */
export const LEGACY_GROUP_KEY = "legacy";

/**
 * Fold rate-set buckets into one group per `(service, mode)`, plus the legacy
 * bucket. Sorted so the wire shape is stable: subscriptions first (they are the
 * allowance side of the split), then metered, then legacy last — it is the one
 * group that says nothing about where the usage went.
 */
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
    // A `sub` row spent nothing — `cost_usd` is already zero for it, but the
    // column is what makes that a rule rather than a coincidence of the writer.
    if (billingMode !== "sub") group.costUsd += r.cost ?? 0;
    // req 16 puts the "would have cost" comparison on `sub` rows and nowhere
    // else: for a `key` row the rates ARE the spend, so a second figure under a
    // comparison's name would duplicate it.
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
    // docs/260 §5 — the account the session's PREVIOUS turn ran on, for the
    // req-10 "Continuing on X" change notice. Primary turns only: a sub-agent
    // consult routes independently and must not read as the session moving.
    this.stmtLastRoute = this.db.prepare(`
      SELECT credential_route_id FROM usage_turns
      WHERE session_id = ? AND sub_agent_id IS NULL AND credential_route_id IS NOT NULL
      ORDER BY id DESC LIMIT 1
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
    // See {@link RecordedTurn.cumulativeSnapshot}: a per-turn row still carries
    // the harness's running total forward when it reported one, so a later
    // cumulative turn of the same conversation diffs against a live baseline
    // rather than treating the whole conversation as one turn.
    let cumulative: number | null = extra?.cumulativeSnapshot ?? null;
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
      extra?.credentialRouteId ?? null,
    );
    return perTurnCost;
  }

  /**
   * docs/260 §5 — the credential route the session's most recent primary turn
   * authenticated with, or `undefined` when no turn recorded one.
   */
  lastTurnCredentialRouteId(sessionId: string): string | undefined {
    const row = this.stmtLastRoute.get(sessionId) as { credential_route_id: string } | undefined;
    return row?.credential_route_id ?? undefined;
  }

  /**
   * Aggregated usage for a single session, split by `(service, billing mode)`
   * (docs/252 req 16). Carries its `groups` because this is the session the
   * user is looking at; the all-sessions list gets totals alone.
   */
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
      applyAttribution(turn, r);
      out.push(turn);
    }
    return out;
  }

  /** Get aggregated usage across all sessions, split by `(service, billing mode)`. */
  getStats(): UsageStats {
    // Per session, the same split — folded down to totals, because nothing in
    // the all-sessions list ranks or renders by group.
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

  /**
   * Per-week buckets for the trend chart. `created_at` is a UTC timestamp;
   * `date(x, 'weekday 0', '-6 days')` snaps it to that week's MONDAY (advance
   * to the coming Sunday, step back six days), giving stable `YYYY-MM-DD` keys,
   * oldest → newest.
   *
   * Grouped by week AND by the split's own key, so each week's three series can
   * be built from the same folding rule the headline uses — a week's "Paid"
   * cannot drift from the total it rolls up into.
   */
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
    applyAttribution(turn, row);
    return turn;
  }
}

/**
 * docs/252 req 16 — stamp a turn with how it was billed and what its tokens are
 * worth at the rates persisted with the row.
 *
 * Recomputed here rather than stored, for the same reason the aggregation
 * recomputes: the value is a function of this row's own rates and tokens, so it
 * must never be re-derived from a live price table. A `legacy` row carries no
 * rates and gets neither field — which is what the per-turn column reads to know
 * it cannot say anything about that turn.
 */
function applyAttribution(turn: TurnUsage | UsageTurn, row: UsageRow): void {
  if (row.billing_mode !== "sub" && row.billing_mode !== "key") return;
  turn.billingMode = row.billing_mode;
  // `sub` only — see {@link TurnUsage.atApiRatesUsd}. A `key` turn's `costUsd`
  // is already the figure derived from these rates.
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
