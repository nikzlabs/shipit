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

  it("aggregates multiple turns for the same session", () => {
    const mgr = new UsageManager(dbManager);
    mgr.record("sess-1", 0.10, 2000);
    mgr.record("sess-1", 0.15, 4000);

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
    mgr.record("sess-1", 0.10, 2000);
    mgr.record("sess-2", 0.20, 5000);
    mgr.record("sess-1", 0.05, 1000);

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
    mgr1.record("sess-1", 0.50, 10000);
    mgr1.record("sess-1", 0.25, 5000);

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
});
