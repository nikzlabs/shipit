import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { UsageManager } from "./usage.js";

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
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.totalTurns).toBe(0);
    expect(stats.sessions).toEqual([]);
  });

  it("records a turn", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("sess-1", 0.05, 3000);

    const stats = mgr.getStats();
    expect(stats.totalCostUsd).toBe(0.05);
    expect(stats.totalTurns).toBe(1);
    expect(stats.sessions).toHaveLength(1);
    expect(stats.sessions[0]).toMatchObject({
      sessionId: "sess-1",
      totalCostUsd: 0.05,
      totalDurationMs: 3000,
      turnCount: 1,
    });
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
      totalCostUsd: 0.25,
      totalDurationMs: 6000,
      turnCount: 2,
    });
  });

  it("tracks multiple sessions independently", () => {
    const mgr = new UsageManager(dbManager);
    // Cumulative running totals per session: sess-1 0.10 then 0.15 (delta 0.05),
    // sess-2 0.20 (delta 0.20). Each session keeps its own delta baseline.
    mgr.record("sess-1", 0.10, 2000);
    mgr.record("sess-2", 0.20, 5000);
    mgr.record("sess-1", 0.15, 1000);

    const stats = mgr.getStats();
    expect(stats.totalCostUsd).toBeCloseTo(0.35);
    expect(stats.totalTurns).toBe(3);
    expect(stats.sessions).toHaveLength(2);

    const s1 = mgr.getSessionUsage("sess-1");
    expect(s1).toBeDefined();
    expect(s1!.totalCostUsd).toBeCloseTo(0.15);
    expect(s1!.turnCount).toBe(2);

    const s2 = mgr.getSessionUsage("sess-2");
    expect(s2).toBeDefined();
    expect(s2!.totalCostUsd).toBeCloseTo(0.20);
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
    expect(stats.totalCostUsd).toBe(0.75);
    expect(stats.totalTurns).toBe(2);
  });

  it("records zero cost gracefully", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("sess-1", 0, 1000);

    const usage = mgr.getSessionUsage("sess-1");
    expect(usage).toMatchObject({
      totalCostUsd: 0,
      turnCount: 1,
      totalDurationMs: 1000,
    });
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
    expect(mgr.getSessionUsage("sess-1")).toMatchObject({ totalCostUsd: 0.14, turnCount: 2 });
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
    expect(mgr.getSessionUsage("s")!.totalCostUsd).toBeCloseTo(6.05);
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
    expect(mgr.getSessionUsage("s")!.totalCostUsd).toBeCloseTo(11.45);
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
    expect(mgr.getSessionUsage("s")!.totalCostUsd).toBeCloseTo(59.98, 2);
  });

  it("persists the cumulative baseline across manager instances (orchestrator restart)", () => {
    const mgr1 = new UsageManager(dbManager);
    mgr1.record("s", 5.0, 1000); // cumulative 5.00, delta 5.00

    // A fresh manager (process restart) must read the prior cumulative from the
    // DB to diff the next turn, not start from zero.
    const mgr2 = new UsageManager(dbManager);
    mgr2.record("s", 7.5, 1000); // cumulative 7.50, delta 2.50
    expect(mgr2.getSessionUsage("s")!.totalCostUsd).toBeCloseTo(7.5);
  });

  it("keeps a sub-agent consult out of the primary delta baseline", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("s", 2.0, 1000); // primary cumulative 2.00, delta 2.00
    mgr.record("s", 0.30, 500, 400, 50, { subAgentId: "codex" }); // verbatim 0.30
    mgr.record("s", 3.0, 1000); // primary cumulative 3.00 — must diff vs 2.00, not 0.30

    const turns = mgr.getSessionTurns("s");
    expect(turns.map((t) => Number(t.costUsd.toFixed(2)))).toEqual([2.0, 0.3, 1.0]);
    expect(mgr.getSessionUsage("s")!.totalCostUsd).toBeCloseTo(3.3);
  });

  it("returns the recorded per-turn delta for the live emit", () => {
    const mgr = new UsageManager(dbManager);
    expect(mgr.record("s", 0.41, 1000)).toBeCloseTo(0.41); // first → baseline
    expect(mgr.record("s", 6.05, 1000)).toBeCloseTo(5.64); // delta
    expect(mgr.record("s", 0.5, 500, 1, 1, { subAgentId: "codex" })).toBeCloseTo(0.5); // verbatim
  });
});
