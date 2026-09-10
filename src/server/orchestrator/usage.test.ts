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
    const insert = dbManager.db.prepare(
      "INSERT INTO usage_turns (session_id, cost_usd, duration_ms, created_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("sess-1", 1.0, 1000, "2026-06-01T12:00:00Z");
    insert.run("sess-1", 2.0, 1000, "2026-06-07T23:30:00Z");
    insert.run("sess-2", 5.0, 1000, "2026-06-15T12:00:00Z");

    const { weekly } = mgr.getStats();
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
    mgr.record("sess-1", 0.10, 2000, 800, 100, { contextTokens: 1500 });
    mgr.record("sess-1", 0.04, 1000, 500, 60, { subAgentId: "codex", contextTokens: 700 });

    expect(mgr.getSessionUsage("sess-1")!.totals.legacyCostUsd).toBeCloseTo(0.14);
    expect(mgr.getSessionUsage("sess-1")!.turnCount).toBe(2);
    expect(mgr.getSessionTokenTotals("sess-1")).toEqual({
      cumulativeInputTokens: 1300,
      cumulativeOutputTokens: 160,
    });

    const dialTurns = mgr.getPerTurnUsage("sess-1");
    expect(dialTurns).toHaveLength(1);
    expect(dialTurns[0].contextTokens).toBe(1500);
  });
});

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
    const cumulative = [0.41, 0.41, 0.58, 1.23, 1.23, 6.05];
    for (const c of cumulative) mgr.record("s", c, 1000);

    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(6.05);
    const turns = mgr.getSessionTurns("s");
    expect(turns.map((t) => Number(t.costUsd.toFixed(2)))).toEqual([
      0.41, 0.0, 0.17, 0.65, 0.0, 4.82,
    ]);
  });

  it("treats a no-op (zero-token) turn that repeats the running total as $0", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0.41, 1000);
    mgr.record("s", 0.41, 800);
    const turns = mgr.getSessionTurns("s");
    expect(turns[1].costUsd).toBeCloseTo(0);
  });

  it("treats a cumulative drop (resume chain reset) as a fresh baseline", () => {
    const mgr = new UsageManager(dbManager);
    for (const c of [0.41, 6.05]) mgr.record("s", c, 1000);
    for (const c of [1.12, 5.40]) mgr.record("s", c, 1000);

    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(11.45);
    const turns = mgr.getSessionTurns("s");
    expect(turns.map((t) => Number(t.costUsd.toFixed(2)))).toEqual([0.41, 5.64, 1.12, 4.28]);
  });

  it("end-to-end mirrors the reported $356 session: ~6× over-count collapses to ~$60", () => {
    const mgr = new UsageManager(dbManager);
    const chains = [
      [0.41, 0.41, 0.58, 0.81, 1.23, 1.23, 1.39, 1.48, 1.57, 2.64, 2.91, 4.33, 4.74, 5.0, 5.7, 6.05],
      [1.12, 1.97, 2.26, 3.46, 4.16, 5.02, 5.4],
      [2.84, 4.55],
      [3.11, 3.54, 4.21, 5.47, 7.07, 7.45, 9.44, 9.61, 10.2, 12.64, 13.41, 16.71, 18.74, 19.05, 20.48, 22.02],
      [6.57, 8.07],
      [2.74, 7.98, 9.7, 12.75, 13.31, 13.47, 13.67, 13.89],
    ];
    for (const chain of chains) for (const c of chain) mgr.record("s", c, 1000);

    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(59.98, 2);
  });

  it("persists the cumulative baseline across manager instances (orchestrator restart)", () => {
    const mgr1 = new UsageManager(dbManager);
    mgr1.record("s", 5.0, 1000);

    const mgr2 = new UsageManager(dbManager);
    mgr2.record("s", 7.5, 1000);
    expect(mgr2.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(7.5);
  });

  it("keeps a sub-agent consult out of the primary delta baseline", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 2.0, 1000);
    mgr.record("s", 0.30, 500, 400, 50, { subAgentId: "codex" });
    mgr.record("s", 3.0, 1000);

    const turns = mgr.getSessionTurns("s");
    expect(turns.map((t) => Number(t.costUsd.toFixed(2)))).toEqual([2.0, 0.3, 1.0]);
    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(3.3);
  });

  it("returns the recorded per-turn delta for the live emit", () => {
    const mgr = new UsageManager(dbManager);
    expect(mgr.record("s", 0.41, 1000)).toBeCloseTo(0.41);
    expect(mgr.record("s", 6.05, 1000)).toBeCloseTo(5.64);
    expect(mgr.record("s", 0.5, 500, 1, 1, { subAgentId: "codex" })).toBeCloseTo(0.5);
  });
});

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
    const mgr = new UsageManager(dbManager);
    mgr.record("s1", 0.1, 1000, 500, 100, { attribution });
    mgr.record("s2", 0.1, 1000, 500, 100, {
      attribution: { ...attribution, rates: { ...attribution.rates, input: 0.56 } },
    });

    expect(rowOf("s1")).toMatchObject({ rate_input: 0.28 });
    expect(rowOf("s2")).toMatchObject({ rate_input: 0.56 });
  });
});

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
    expect(mgr.record("s", 2.0, 1000, 0, 0, { costSource: "per-turn" })).toBeCloseTo(2.0);
    expect(mgr.record("s", 0.35, 1000, 0, 0, { costSource: "per-turn" })).toBeCloseTo(0.35);
    expect(mgr.getSessionUsage("s")!.totals.legacyCostUsd).toBeCloseTo(2.35);
  });

  it("leaves a per-turn row out of the cumulative baseline chain", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 2.0, 1000);
    mgr.record("s", 0.35, 1000, 0, 0, { costSource: "per-turn" });
    mgr.record("s", 3.0, 1000);

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
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 2.0, 1000);
    const first = mgr.record("s", 9.0, 1000, 1, 1, {
      subAgentId: "codex",
      costSource: "cumulative",
    });
    const second = mgr.record("s", 11.0, 1000, 1, 1, {
      subAgentId: "codex",
      costSource: "cumulative",
    });
    expect(first).toBeCloseTo(9.0);
    expect(second).toBeCloseTo(2.0);

    expect(mgr.record("s", 3.0, 1000)).toBeCloseTo(1.0);
  });

  it("keeps two different sub-agents' chains apart", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 5.0, 1000, 1, 1, { subAgentId: "codex", costSource: "cumulative" });
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
    const mgr = new UsageManager(dbManager);
    mgr.record("s1", 0, 100, 10, 5, { costSource: "per-turn", cumulativeSnapshot: 4 });
    mgr.record("s1", 0, 100, 10, 5, { costSource: "per-turn", cumulativeSnapshot: 9 });
    const delta = mgr.record("s1", 11, 100, 10, 5, { costSource: "cumulative" });
    expect(delta).toBe(2);
    expect(mgr.getSessionUsage("s1")?.totals.legacyCostUsd).toBe(2);
  });

  it("leaves a per-turn row with no snapshot out of the chain entirely", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s1", 3, 100, 10, 5, { costSource: "cumulative" });
    mgr.record("s1", 0.5, 100, 10, 5, { costSource: "per-turn" });
    expect(mgr.record("s1", 5, 100, 10, 5, { costSource: "cumulative" })).toBe(2);
  });
});

describe("UsageManager — the usage split (docs/252 req 16)", () => {
  let dbManager: DatabaseManager;
  beforeEach(() => { dbManager = new DatabaseManager(":memory:"); });
  afterEach(() => { dbManager.close(); });

  const rates = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
  const sub = (serviceId: string) => ({ serviceId, billingMode: "sub" as const, rates });
  const key = (serviceId: string) => ({ serviceId, billingMode: "key" as const, rates });

  const groupOf = (groups: UsageGroup[], k: string) => groups.find((g) => g.key === k);

  it("splits by (service, billing mode) and keeps the two dollar figures apart", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0, 1000, 600_000, 400_000, {
      costSource: "per-turn", attribution: sub("anthropic"), model: "claude-opus-5",
    });
    mgr.record("s", 0.5, 1000, 200_000, 50_000, {
      costSource: "per-turn", attribution: key("deepseek"), model: "deepseek-flash",
    });

    const usage = mgr.getSessionUsage("s")!;
    expect(usage.groups!.map((g) => g.key)).toEqual(["anthropic:sub", "deepseek:key"]);

    expect(usage.totals.meteredCostUsd).toBeCloseTo(0.5);
    expect(usage.totals.atApiRatesUsd).toBeCloseTo(1.0);
    expect(usage.totals.includedTokens).toBe(1_000_000);
    expect(usage.totals.meteredTokens).toBe(250_000);

    const plan = groupOf(usage.groups!, "anthropic:sub")!;
    expect(plan.costUsd).toBe(0);
    expect(plan.atApiRatesUsd).toBeCloseTo(1.0);
    expect(plan.models).toEqual(["claude-opus-5"]);
    const metered = groupOf(usage.groups!, "deepseek:key")!;
    expect(metered.costUsd).toBeCloseTo(0.5);
    expect(metered.atApiRatesUsd).toBe(0);
  });

  it("keeps one service's two billing modes as two rows, not one", () => {
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
    mgr.record("s", 3.0, 1000, 10_000, 5_000);
    mgr.record("s", 0.5, 1000, 200_000, 50_000, {
      costSource: "per-turn", attribution: key("deepseek"),
    });

    const totals = mgr.getSessionUsage("s")!.totals;
    expect(totals.meteredCostUsd).toBeCloseTo(0.5);
    expect(totals.atApiRatesUsd).toBe(0);
    expect(totals.legacyCostUsd).toBeCloseTo(3.0);
    expect(totals.legacyTokens).toBe(15_000);

    const legacy = groupOf(mgr.getSessionUsage("s")!.groups!, "legacy")!;
    expect(legacy.kind).toBe("legacy");
    expect(legacy.serviceId).toBeUndefined();
    expect(legacy.billingMode).toBeUndefined();
    expect(mgr.getSessionUsage("s")!.groups!.at(-1)!.key).toBe("legacy");
  });

  it("recomputes at API rates from the rates PERSISTED with each row", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 0, 1000, 1_000_000, 0, {
      costSource: "per-turn",
      attribution: { serviceId: "anthropic", billingMode: "sub", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    });
    mgr.record("s", 0, 1000, 1_000_000, 0, {
      costSource: "per-turn",
      attribution: { serviceId: "anthropic", billingMode: "sub", rates: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 } },
    });

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
    expect(turns[0]).toMatchObject({ costUsd: 0, billingMode: "sub" });
    expect(turns[0].atApiRatesUsd).toBeCloseTo(1);
    expect(turns[1]).toMatchObject({ costUsd: 0.5, billingMode: "key" });
    expect(turns[1].atApiRatesUsd).toBeUndefined();
    expect(turns[2].billingMode).toBeUndefined();
    expect(turns[2].atApiRatesUsd).toBeUndefined();
  });

  it("splits the all-sessions view and the weekly series the same way", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("a", 0, 1000, 1_000_000, 0, { costSource: "per-turn", attribution: sub("anthropic") });
    mgr.record("b", 0.75, 1000, 500_000, 0, { costSource: "per-turn", attribution: key("deepseek") });
    mgr.record("c", 4.0, 1000, 100_000, 0);

    const stats = mgr.getStats();
    expect(stats.totals.meteredCostUsd).toBeCloseTo(0.75);
    expect(stats.totals.atApiRatesUsd).toBeCloseTo(1);
    expect(stats.totals.legacyCostUsd).toBeCloseTo(4);
    expect(stats.groups.map((g) => g.key)).toEqual(["anthropic:sub", "deepseek:key", "legacy"]);
    expect(stats.totalTurns).toBe(3);

    const bySession = new Map(stats.sessions.map((s) => [s.sessionId, s.totals]));
    expect(bySession.get("a")!.meteredCostUsd).toBe(0);
    expect(bySession.get("a")!.atApiRatesUsd).toBeCloseTo(1);
    expect(bySession.get("b")!.meteredCostUsd).toBeCloseTo(0.75);
    expect(bySession.get("c")!.legacyCostUsd).toBeCloseTo(4);

    expect(mgr.getStats().weekly).toHaveLength(1);
    const week = mgr.getStats().weekly[0];
    expect(week.costUsd).toBeCloseTo(0.75);
    expect(week.atApiRatesUsd).toBeCloseTo(1);
    expect(week.tokens).toBe(1_600_000);
  });
});
