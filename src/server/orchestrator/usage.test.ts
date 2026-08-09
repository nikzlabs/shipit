import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { UsageManager } from "./usage.js";
import type { UsageGroup } from "../shared/types.js";

describe("UsageManager", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });

  afterEach(() => {
    dbManager.close();
  });

  it("starts with empty data", () => {
    const mgr = new UsageManager(dbManager);
    const stats = mgr.getStats();
    expect(stats.totals.legacyCostUsd).toBe(0);
    expect(stats.totalTurns).toBe(0);
    expect(stats.sessions).toEqual([]);
    expect(stats.weekly).toEqual([]);
  });

  it("buckets cost and turns by calendar week, keyed on the week's Monday", () => {
    const mgr = new UsageManager(dbManager);
    // Insert with explicit created_at so we span multiple weeks deterministically.
    // 2026-06-01 is a Monday; 2026-06-07 is the Sunday that closes the same week.
    const insert = dbManager.db.prepare(
      "INSERT INTO usage_turns (session_id, cost_usd, duration_ms, created_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("sess-1", 1.0, 1000, "2026-06-01T12:00:00Z");
    insert.run("sess-1", 2.0, 1000, "2026-06-07T23:30:00Z");
    insert.run("sess-2", 5.0, 1000, "2026-06-15T12:00:00Z");

    const { weekly } = mgr.getStats();
    // The idle week (Jun 8–14) is zero-filled so the chart's x-axis stays evenly
    // spaced instead of putting two non-adjacent weeks side by side.
    // Legacy rows are excluded from the metered series — their dollar meaning
    // is unknown (docs/252 req 16) — but their TOKENS are honest, and there are
    // none here. What the chart keeps is the evenly-spaced axis.
    expect(weekly).toEqual([
      { week: "2026-06-01", costUsd: 0, atApiRatesUsd: 0, tokens: 0 },
      { week: "2026-06-08", costUsd: 0, atApiRatesUsd: 0, tokens: 0 },
      { week: "2026-06-15", costUsd: 0, atApiRatesUsd: 0, tokens: 0 },
    ]);
  });

  it("keeps weekly buckets bounded by the data, not the wall clock", () => {
    const mgr = new UsageManager(dbManager);
    dbManager.db
      .prepare("INSERT INTO usage_turns (session_id, cost_usd, duration_ms, created_at) VALUES (?, ?, ?, ?)")
      .run("sess-1", 1.0, 1000, "2026-06-03T12:00:00Z");

    // A single active week yields exactly one bucket — `getStats()` must not
    // extend the series to "now", which would make it clock-dependent.
    expect(mgr.getStats().weekly).toEqual([
      { week: "2026-06-01", costUsd: 0, atApiRatesUsd: 0, tokens: 0 },
    ]);
  });

  it("records a turn", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("sess-1", 0.05, 3000);

    const stats = mgr.getStats();
    expect(stats.totals.legacyCostUsd).toBe(0.05);
    expect(stats.totalTurns).toBe(1);
    expect(stats.sessions).toHaveLength(1);
    expect(stats.sessions[0]).toMatchObject({
      sessionId: "sess-1",
      totalDurationMs: 3000,
      turnCount: 1,
    });
    expect(stats.sessions[0].totals.legacyCostUsd).toBe(0.05);
  });

  it("aggregates multiple turns for the same session (cumulative cost → per-turn deltas)", () => {
    const mgr = new UsageManager(dbManager);
    // Primary turns report the CLI's CUMULATIVE total_cost_usd, not the turn's
    // own cost: 0.10 running total, then 0.25 running total. The recorded
    // per-turn costs are the deltas 0.10 and 0.15, summing to the 0.25 bill.
    mgr.record("sess-1", 0.10, 2000);
    mgr.record("sess-1", 0.25, 4000);

    const usage = mgr.getSessionUsage("sess-1");
    expect(usage).toMatchObject({
      sessionId: "sess-1",
      totalDurationMs: 6000,
      turnCount: 2,
    });
    expect(usage!.totals.legacyCostUsd).toBeCloseTo(0.25);
  });

  it("tracks multiple sessions independently", () => {
    const mgr = new UsageManager(dbManager);
    // Cumulative running totals per session: sess-1 0.10 then 0.15 (delta 0.05),
    // sess-2 0.20 (delta 0.20). Each session keeps its own delta baseline.
    mgr.record("sess-1", 0.10, 2000);
    mgr.record("sess-2", 0.20, 5000);
    mgr.record("sess-1", 0.15, 1000);

    const stats = mgr.getStats();
    expect(stats.totals.legacyCostUsd).toBeCloseTo(0.35);
    expect(stats.totalTurns).toBe(3);
    expect(stats.sessions).toHaveLength(2);

    const s1 = mgr.getSessionUsage("sess-1");
    expect(s1).toBeDefined();
    expect(s1!.totals.legacyCostUsd).toBeCloseTo(0.15);
    expect(s1!.turnCount).toBe(2);

    const s2 = mgr.getSessionUsage("sess-2");
    expect(s2).toBeDefined();
    expect(s2!.totals.legacyCostUsd).toBeCloseTo(0.20);
    expect(s2!.turnCount).toBe(1);
  });

  it("returns undefined for unknown session", () => {
    const mgr = new UsageManager(dbManager);
    expect(mgr.getSessionUsage("nonexistent")).toBeUndefined();
  });

  it("deletes usage data for a session", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("sess-1", 0.10, 2000);
    mgr.record("sess-2", 0.20, 3000);

    const deleted = mgr.delete("sess-1");
    expect(deleted).toBe(true);
    expect(mgr.getSessionUsage("sess-1")).toBeUndefined();
    expect(mgr.getSessionUsage("sess-2")).toBeDefined();

    const stats = mgr.getStats();
    expect(stats.totalTurns).toBe(1);
    expect(stats.sessions).toHaveLength(1);
  });

  it("returns false when deleting nonexistent session", () => {
    const mgr = new UsageManager(dbManager);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  it("persists data across manager instances", () => {
    const mgr1 = new UsageManager(dbManager);
    // Cumulative 0.50 then 0.75 → deltas 0.50 + 0.25.
    mgr1.record("sess-1", 0.50, 10000);
    mgr1.record("sess-1", 0.75, 5000);

    const mgr2 = new UsageManager(dbManager);
    const stats = mgr2.getStats();
    expect(stats.totals.legacyCostUsd).toBe(0.75);
    expect(stats.totalTurns).toBe(2);
  });

  it("records zero cost gracefully", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("sess-1", 0, 1000);

    const usage = mgr.getSessionUsage("sess-1");
    expect(usage).toMatchObject({
      turnCount: 1,
      totalDurationMs: 1000,
    });
    expect(usage!.totals.legacyCostUsd).toBe(0);
  });

  it("records turn with timestamp", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("sess-1", 0.05, 2000);

    const turns = mgr.getSessionTurns("sess-1");
    expect(turns).toHaveLength(1);
    expect(turns[0].timestamp).toBeDefined();
  });

  it("rolls a sub-agent turn into cost + token totals but keeps it out of the context-dial series (docs/144)", () => {
    const mgr = new UsageManager(dbManager);
    // A primary turn, then a sub-agent consult with its own token usage.
    mgr.record("sess-1", 0.10, 2000, 800, 100, { contextTokens: 1500 });
    mgr.record("sess-1", 0.04, 1000, 500, 60, { subAgentId: "codex", contextTokens: 700 });

    // The bill and cumulative tokens DO include the consult (SUM over all rows).
    expect(mgr.getSessionUsage("sess-1")!.totals.legacyCostUsd).toBeCloseTo(0.14);
    expect(mgr.getSessionUsage("sess-1")!.turnCount).toBe(2);
    expect(mgr.getSessionTokenTotals("sess-1")).toEqual({
      cumulativeInputTokens: 1300,
      cumulativeOutputTokens: 160,
    });

    // The dial series excludes the sub-agent turn, so the dial reads the
    // pinned agent's last turn (1500), not the consult's smaller window (700).
    const dialTurns = mgr.getPerTurnUsage("sess-1");
    expect(dialTurns).toHaveLength(1);
    expect(dialTurns[0].contextTokens).toBe(1500);
  });
});

// Regression for the cost-over-count bug: each `claude -p --resume` turn reports
// `total_cost_usd` as the running total of the entire resumed conversation, not
// the turn's own cost. Recording those snapshots verbatim and SUM()-ing them
// over-counted the session bill ~N× (once per resume chain). `record` now diffs
// the cumulative into a per-turn delta.
describe("UsageManager — cumulative cost → per-turn delta", () => {
  let dbManager: DatabaseManager;
  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });
  afterEach(() => {
    dbManager.close();
  });

  it("converts a monotonically-rising cumulative series into the correct bill", () => {
    const mgr = new UsageManager(dbManager);
    // The CLI's running total climbs each turn within one resume chain.
    const cumulative = [0.41, 0.41, 0.58, 1.23, 1.23, 6.05];
    for (const c of cumulative) mgr.record("s", c, 1000);

    // The true bill is the LAST cumulative value (6.05), NOT the sum of the
    // snapshots (the old bug summed to ~10.91).
    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(6.05);
    const turns = mgr.getSessionTurns("s");
    expect(turns.map((t) => Number(t.costUsd.toFixed(2)))).toEqual([
      0.41, 0.0, 0.17, 0.65, 0.0, 4.82,
    ]);
  });

  it("treats a no-op (zero-token) turn that repeats the running total as $0", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0.41, 1000); // turn 1
    mgr.record("s", 0.41, 800); // turn 2: In:0/Out:0, running total unchanged
    const turns = mgr.getSessionTurns("s");
    expect(turns[1].costUsd).toBeCloseTo(0);
  });

  it("treats a cumulative drop (resume chain reset) as a fresh baseline", () => {
    const mgr = new UsageManager(dbManager);
    // Chain A climbs to 6.05, then the container re-clones and a fresh CLI
    // conversation resets the running total to 1.12 and climbs again.
    for (const c of [0.41, 6.05]) mgr.record("s", c, 1000);
    for (const c of [1.12, 5.40]) mgr.record("s", c, 1000);

    // Bill = last-of-chain-A (6.05) + last-of-chain-B (5.40) = 11.45. The reset
    // value 1.12 is a new baseline, not a -4.93 delta.
    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(11.45);
    const turns = mgr.getSessionTurns("s");
    expect(turns.map((t) => Number(t.costUsd.toFixed(2)))).toEqual([0.41, 5.64, 1.12, 4.28]);
  });

  it("end-to-end mirrors the reported $356 session: ~6× over-count collapses to ~$60", () => {
    const mgr = new UsageManager(dbManager);
    // Six resume chains (final cumulative per chain in parens):
    const chains = [
      [0.41, 0.41, 0.58, 0.81, 1.23, 1.23, 1.39, 1.48, 1.57, 2.64, 2.91, 4.33, 4.74, 5.0, 5.7, 6.05], // 6.05
      [1.12, 1.97, 2.26, 3.46, 4.16, 5.02, 5.4], // 5.40
      [2.84, 4.55], // 4.55
      [3.11, 3.54, 4.21, 5.47, 7.07, 7.45, 9.44, 9.61, 10.2, 12.64, 13.41, 16.71, 18.74, 19.05, 20.48, 22.02], // 22.02
      [6.57, 8.07], // 8.07
      [2.74, 7.98, 9.7, 12.75, 13.31, 13.47, 13.67, 13.89], // 13.89
    ];
    for (const chain of chains) for (const c of chain) mgr.record("s", c, 1000);

    // Sum of the per-chain finals — the true bill — not the sum of every
    // snapshot (which is the ~$356.60 the UI reported).
    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(59.98, 2);
  });

  it("persists the cumulative baseline across manager instances (orchestrator restart)", () => {
    const mgr1 = new UsageManager(dbManager);
    mgr1.record("s", 5.0, 1000); // cumulative 5.00, delta 5.00

    // A fresh manager (process restart) must read the prior cumulative from the
    // DB to diff the next turn, not start from zero.
    const mgr2 = new UsageManager(dbManager);
    mgr2.record("s", 7.5, 1000); // cumulative 7.50, delta 2.50
    expect(mgr2.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(7.5);
  });

  it("keeps a sub-agent consult out of the primary delta baseline", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 2.0, 1000); // primary cumulative 2.00, delta 2.00
    mgr.record("s", 0.30, 500, 400, 50, { subAgentId: "codex" }); // verbatim 0.30
    mgr.record("s", 3.0, 1000); // primary cumulative 3.00 — must diff vs 2.00, not 0.30

    const turns = mgr.getSessionTurns("s");
    expect(turns.map((t) => Number(t.costUsd.toFixed(2)))).toEqual([2.0, 0.3, 1.0]);
    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(3.3);
  });

  it("returns the recorded per-turn delta for the live emit", () => {
    const mgr = new UsageManager(dbManager);
    expect(mgr.record("s", 0.41, 1000)).toBeCloseTo(0.41); // first → baseline
    expect(mgr.record("s", 6.05, 1000)).toBeCloseTo(5.64); // delta
    expect(mgr.record("s", 0.5, 500, 1, 1, { subAgentId: "codex" })).toBeCloseTo(0.5); // verbatim
  });
});

/**
 * docs/252 req 16 — usage is reported split by service and billing mode, so the
 * row has to record which one it ran on and at what rates. Landed ahead of the
 * producers: with nobody supplying the fields yet, every row is all-null, which
 * is exactly the `legacy` bucket req 16 already defines for pre-feature rows.
 */
describe("UsageManager — turn attribution (docs/252 req 16)", () => {
  let dbManager: DatabaseManager;
  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });
  afterEach(() => {
    dbManager.close();
  });

  const attribution = {
    serviceId: "deepseek",
    billingMode: "key" as const,
    rates: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  };

  const rowOf = (sessionId: string) =>
    dbManager.db.prepare("SELECT * FROM usage_turns WHERE session_id = ?").get(sessionId) as Record<
      string,
      unknown
    >;

  it("persists the service, the billing mode and all four rates in force", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0.1, 1000, 500, 100, { attribution });

    expect(rowOf("s")).toMatchObject({
      service_id: "deepseek",
      billing_mode: "key",
      rate_input: 0.28,
      rate_output: 0.42,
      rate_cache_read: 0.028,
      // Zero is a real answer here — a service that charges nothing to write the
      // cache — and must not collapse into "no rate recorded", which is what the
      // CHECK constraint's all-or-nothing rule distinguishes.
      rate_cache_write: 0,
    });
  });

  it("writes a legacy (all-null) row when no attribution is supplied", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0.1, 1000);

    expect(rowOf("s")).toMatchObject({
      service_id: null,
      billing_mode: null,
      rate_input: null,
      rate_output: null,
      rate_cache_read: null,
      rate_cache_write: null,
    });
  });

  it("records the rates that were in force, not whatever the catalogue says later", () => {
    // The reason the rates are columns rather than a read-time lookup: a price
    // edit must not restate history, and a retired model has no price to look up
    // at all. Two turns at different rates keep their own.
    const mgr = new UsageManager(dbManager);
    mgr.record("s1", 0.1, 1000, 500, 100, { attribution });
    mgr.record("s2", 0.1, 1000, 500, 100, {
      attribution: { ...attribution, rates: { ...attribution.rates, input: 0.56 } },
    });

    expect(rowOf("s1")).toMatchObject({ rate_input: 0.28 });
    expect(rowOf("s2")).toMatchObject({ rate_input: 0.56 });
  });
});

/**
 * docs/252 phase 3 — the cumulative-to-delta conversion branches on the SOURCE
 * of the value, not on `subAgentId`. "Not a sub-agent implies cumulative" holds
 * only while the sole producer is a harness billing its own vendor; a
 * rate-derived figure is already per-turn and must not be delta'd again.
 */
describe("UsageManager — cost-source discriminator", () => {
  let dbManager: DatabaseManager;
  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });
  afterEach(() => {
    dbManager.close();
  });

  it("stores a per-turn cost verbatim, even for a primary turn", () => {
    const mgr = new UsageManager(dbManager);
    // Under the old rule this pair would come out as 2.00 and 0.00: the second
    // value would be read as a running total that went DOWN, i.e. a reset — the
    // exact silent corruption the discriminator exists to prevent.
    expect(mgr.record("s", 2.0, 1000, 0, 0, { costSource: "per-turn" })).toBeCloseTo(2.0);
    expect(mgr.record("s", 0.35, 1000, 0, 0, { costSource: "per-turn" })).toBeCloseTo(0.35);
    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(2.35);
  });

  it("leaves a per-turn row out of the cumulative baseline chain", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 2.0, 1000); // cumulative 2.00 → delta 2.00
    mgr.record("s", 0.35, 1000, 0, 0, { costSource: "per-turn" }); // verbatim
    mgr.record("s", 3.0, 1000); // cumulative 3.00 — diffs vs 2.00, not 0.35

    const turns = mgr.getSessionTurns("s");
    expect(turns.map((t) => Number(t.costUsd.toFixed(2)))).toEqual([2.0, 0.35, 1.0]);
  });

  it("defaults to cumulative for a primary turn — today's behaviour, unchanged", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 2.0, 1000);
    expect(mgr.record("s", 3.0, 1000)).toBeCloseTo(1.0);
  });

  it("defaults to per-turn for a sub-agent consult — today's behaviour, unchanged", () => {
    const mgr = new UsageManager(dbManager);
    expect(mgr.record("s", 0.3, 500, 1, 1, { subAgentId: "codex" })).toBeCloseTo(0.3);
    expect(mgr.record("s", 0.3, 500, 1, 1, { subAgentId: "codex" })).toBeCloseTo(0.3);
    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(0.6);
  });

  it("gives a cumulative consult its OWN chain, not the primary agent's", () => {
    // A running total belongs to one conversation, so the chain is keyed by
    // `(session, subAgentId)`. Without that key the consult below would diff
    // 9.00 against the primary agent's unrelated 2.00 and persist 7.00 — a wrong
    // number rather than a missing one, and only reachable at all because the
    // discriminator makes a cumulative consult expressible.
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 2.0, 1000); // primary cumulative 2.00 → delta 2.00
    const first = mgr.record("s", 9.0, 1000, 1, 1, {
      subAgentId: "codex",
      costSource: "cumulative",
    });
    const second = mgr.record("s", 11.0, 1000, 1, 1, {
      subAgentId: "codex",
      costSource: "cumulative",
    });
    expect(first).toBeCloseTo(9.0); // first of ITS chain → its own baseline
    expect(second).toBeCloseTo(2.0); // 11.00 − 9.00, not 11.00 − 2.00

    // And the primary chain is still untouched by either.
    expect(mgr.record("s", 3.0, 1000)).toBeCloseTo(1.0); // diffs vs 2.00
  });

  it("keeps two different sub-agents' chains apart", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 5.0, 1000, 1, 1, { subAgentId: "codex", costSource: "cumulative" });
    // A different consult's first turn is its own baseline, not a delta against
    // the other consult's 5.00.
    expect(
      mgr.record("s", 2.0, 1000, 1, 1, { subAgentId: "gemini", costSource: "cumulative" }),
    ).toBeCloseTo(2.0);
  });
});

describe("UsageManager — the delta chain survives a billing-mode switch (docs/252 phase 3)", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => { dbManager = new DatabaseManager(":memory:"); });
  afterEach(() => { dbManager.close(); });

  it("carries the harness's running total forward on a turn that did not take its cost from it", () => {
    // A subscription session records `cost_usd: 0` — nothing was billed — but
    // the CLI's `total_cost_usd` keeps rising across the whole resumed
    // conversation. Switch the session to the same service's metered key and the
    // first key turn must charge only ITS delta. Without the carried snapshot it
    // finds no baseline and records the entire conversation as one turn's spend.
    const mgr = new UsageManager(dbManager);
    mgr.record("s1", 0, 100, 10, 5, { costSource: "per-turn", cumulativeSnapshot: 4 });
    mgr.record("s1", 0, 100, 10, 5, { costSource: "per-turn", cumulativeSnapshot: 9 });
    const delta = mgr.record("s1", 11, 100, 10, 5, { costSource: "cumulative" });
    expect(delta).toBe(2);
    expect(mgr.getSessionUsage("s1")?.totals.legacyCostUsd).toBe(2);
  });

  it("leaves a per-turn row with no snapshot out of the chain entirely", () => {
    // A rate-derived figure from a harness that reports no running total (Codex)
    // must not become a baseline, or the next cumulative turn would diff against
    // a number in a different currency of meaning.
    const mgr = new UsageManager(dbManager);
    mgr.record("s1", 3, 100, 10, 5, { costSource: "cumulative" });
    mgr.record("s1", 0.5, 100, 10, 5, { costSource: "per-turn" });
    expect(mgr.record("s1", 5, 100, 10, 5, { costSource: "cumulative" })).toBe(2);
  });
});

/**
 * docs/252 req 16 (phase 6) — the SPLIT the recorded attribution exists for.
 *
 * The contract under test, stated once so a change to it is a deliberate edit
 * rather than a surprise:
 *
 *  - **Metered spend** SUMS the stored `cost_usd`, over `key` rows only.
 *  - **At API rates** RECOMPUTES from each row's persisted rates and tokens,
 *    over `sub` rows only.
 *  - Neither reads the other's source, and neither reads the live catalogue.
 *  - **Legacy rows are in neither.** Their attribution is unknown and so is
 *    their dollar meaning, so they carry their own unqualified total.
 */
describe("UsageManager — the usage split (docs/252 req 16)", () => {
  let dbManager: DatabaseManager;
  beforeEach(() => { dbManager = new DatabaseManager(":memory:"); });
  afterEach(() => { dbManager.close(); });

  /** $1 per million on every class, so a rate-derived figure is readable by eye. */
  const rates = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
  const sub = (serviceId: string) => ({ serviceId, billingMode: "sub" as const, rates });
  const key = (serviceId: string) => ({ serviceId, billingMode: "key" as const, rates });

  const groupOf = (groups: UsageGroup[], k: string) => groups.find((g) => g.key === k);

  it("splits by (service, billing mode) and keeps the two dollar figures apart", () => {
    const mgr = new UsageManager(dbManager);
    // A subscription turn: 1M tokens, cost_usd 0 by rule.
    mgr.record("s", 0, 1000, 600_000, 400_000, {
      costSource: "per-turn", attribution: sub("anthropic"), model: "claude-opus-5",
    });
    // A metered turn on another service: cost_usd is the money.
    mgr.record("s", 0.5, 1000, 200_000, 50_000, {
      costSource: "per-turn", attribution: key("deepseek"), model: "deepseek-v4-flash",
    });

    const usage = mgr.getSessionUsage("s")!;
    expect(usage.groups!.map((g) => g.key)).toEqual(["anthropic:sub", "deepseek:key"]);

    // The subscription row contributes NOTHING to metered spend, and its
    // at-API-rates value is recomputed from its own persisted rates: 1M tokens
    // at $1/M = $1.00.
    expect(usage.totals.meteredCostUsd).toBeCloseTo(0.5);
    expect(usage.totals.atApiRatesUsd).toBeCloseTo(1.0);
    expect(usage.totals.includedTokens).toBe(1_000_000);
    expect(usage.totals.meteredTokens).toBe(250_000);

    const plan = groupOf(usage.groups!, "anthropic:sub")!;
    expect(plan.costUsd).toBe(0);
    expect(plan.atApiRatesUsd).toBeCloseTo(1.0);
    expect(plan.models).toEqual(["claude-opus-5"]);
    expect(groupOf(usage.groups!, "deepseek:key")!.costUsd).toBeCloseTo(0.5);
  });

  it("keeps one service's two billing modes as two rows, not one", () => {
    // The case that forces the split to be the MODE and not the service: GLM's
    // coding plan and its API key are one service, and merging them would put a
    // metered price against a row that is mostly free.
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0, 1000, 100_000, 0, { costSource: "per-turn", attribution: sub("zai") });
    mgr.record("s", 0.25, 1000, 50_000, 0, { costSource: "per-turn", attribution: key("zai") });

    const groups = mgr.getSessionUsage("s")!.groups!;
    expect(groups.map((g) => g.key)).toEqual(["zai:sub", "zai:key"]);
    expect(groupOf(groups, "zai:sub")!.costUsd).toBe(0);
    expect(groupOf(groups, "zai:key")!.costUsd).toBeCloseTo(0.25);
  });

  it("excludes legacy rows from BOTH dollar figures, with their own total", () => {
    const mgr = new UsageManager(dbManager);
    // A pre-feature row: a cost of unknown provenance and no rates at all.
    mgr.record("s", 3.0, 1000, 10_000, 5_000);
    mgr.record("s", 0.5, 1000, 200_000, 50_000, {
      costSource: "per-turn", attribution: key("deepseek"),
    });

    const totals = mgr.getSessionUsage("s")!.totals;
    expect(totals.meteredCostUsd).toBeCloseTo(0.5); // NOT 3.5
    expect(totals.atApiRatesUsd).toBe(0); // legacy has no rates to recompute from
    expect(totals.legacyCostUsd).toBeCloseTo(3.0);
    expect(totals.legacyTokens).toBe(15_000);

    const legacy = groupOf(mgr.getSessionUsage("s")!.groups!, "legacy")!;
    expect(legacy.kind).toBe("legacy");
    expect(legacy.serviceId).toBeUndefined();
    expect(legacy.billingMode).toBeUndefined();
    // Last, because it is the group that drains on its own.
    expect(mgr.getSessionUsage("s")!.groups!.at(-1)!.key).toBe("legacy");
  });

  it("recomputes at API rates from the rates PERSISTED with each row", () => {
    // Two turns of the same (service, mode) at different rates — a price edit,
    // or a second model. Recomputing per row is what stops a later price from
    // restating what an earlier turn was worth.
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0, 1000, 1_000_000, 0, {
      costSource: "per-turn",
      attribution: { serviceId: "anthropic", billingMode: "sub", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    });
    mgr.record("s", 0, 1000, 1_000_000, 0, {
      costSource: "per-turn",
      attribution: { serviceId: "anthropic", billingMode: "sub", rates: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 } },
    });

    // $3 + $6 — the average of the two rates would give $9 too, so the check
    // that matters is the SECOND one: a single row priced at the other's rate.
    expect(mgr.getSessionUsage("s")!.totals.atApiRatesUsd).toBeCloseTo(9);
  });

  it("prices every token class, cache included", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0, 1000, 1_000_000, 1_000_000, {
      costSource: "per-turn",
      cacheRead: 1_000_000,
      cacheCreate: 1_000_000,
      attribution: { serviceId: "anthropic", billingMode: "sub", rates: { input: 1, output: 2, cacheRead: 4, cacheWrite: 8 } },
    });
    expect(mgr.getSessionUsage("s")!.totals.atApiRatesUsd).toBeCloseTo(15);
    expect(mgr.getSessionUsage("s")!.totals.includedTokens).toBe(4_000_000);
  });

  it("marks each per-turn row with its mode and its at-API-rates value", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0, 1000, 1_000_000, 0, { costSource: "per-turn", attribution: sub("anthropic") });
    mgr.record("s", 0.5, 1000, 0, 0, { costSource: "per-turn", attribution: key("deepseek") });
    mgr.record("s", 2.0, 1000, 100, 100);

    const turns = mgr.getSessionTurns("s");
    // A subscription turn reports zero money and a non-zero comparison — which
    // is what lets the per-turn column show "included at API rates" rather than
    // reporting the turn as free.
    expect(turns[0]).toMatchObject({ costUsd: 0, billingMode: "sub" });
    expect(turns[0].atApiRatesUsd).toBeCloseTo(1);
    expect(turns[1]).toMatchObject({ costUsd: 0.5, billingMode: "key" });
    // A legacy row can say neither.
    expect(turns[2].billingMode).toBeUndefined();
    expect(turns[2].atApiRatesUsd).toBeUndefined();
  });

  it("splits the all-sessions view and the weekly series the same way", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("a", 0, 1000, 1_000_000, 0, { costSource: "per-turn", attribution: sub("anthropic") });
    mgr.record("b", 0.75, 1000, 500_000, 0, { costSource: "per-turn", attribution: key("deepseek") });
    mgr.record("c", 4.0, 1000, 100_000, 0); // legacy

    const stats = mgr.getStats();
    expect(stats.totals.meteredCostUsd).toBeCloseTo(0.75);
    expect(stats.totals.atApiRatesUsd).toBeCloseTo(1);
    expect(stats.totals.legacyCostUsd).toBeCloseTo(4);
    expect(stats.groups.map((g) => g.key)).toEqual(["anthropic:sub", "deepseek:key", "legacy"]);
    expect(stats.totalTurns).toBe(3);

    // Per-session totals carry the same split, so the by-spend ranking can rank
    // on money and fall through to the estimate.
    const bySession = new Map(stats.sessions.map((s) => [s.sessionId, s.totals]));
    expect(bySession.get("a")!.meteredCostUsd).toBe(0);
    expect(bySession.get("a")!.atApiRatesUsd).toBeCloseTo(1);
    expect(bySession.get("b")!.meteredCostUsd).toBeCloseTo(0.75);
    expect(bySession.get("c")!.legacyCostUsd).toBeCloseTo(4);

    // One week, three series. `costUsd` is metered only — the legacy $4 is NOT
    // in it — while the token series counts every row, attributed or not.
    expect(mgr.getStats().weekly).toHaveLength(1);
    const week = mgr.getStats().weekly[0];
    expect(week.costUsd).toBeCloseTo(0.75);
    expect(week.atApiRatesUsd).toBeCloseTo(1);
    expect(week.tokens).toBe(1_600_000);
  });
});
