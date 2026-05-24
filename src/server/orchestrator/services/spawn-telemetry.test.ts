import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  classifySpawnFailure,
  getSpawnTelemetrySnapshot,
  recordSpawnInvocation,
  resetSpawnTelemetry,
} from "./spawn-telemetry.js";

/**
 * Tests for the spawn-invocation telemetry (docs/117 cross-cutting follow-up).
 *
 * The counters are module-level singletons so the tests reset them around
 * each case. The `[spawn-telemetry]` log line is captured by spying on
 * `console.log` — that's the structured surface external log scrapers
 * consume.
 */

describe("classifySpawnFailure", () => {
  it("maps 404 to parent_missing", () => {
    expect(classifySpawnFailure(404, "Parent session not found")).toBe("parent_missing");
  });

  it("maps 400 to invalid_request", () => {
    expect(classifySpawnFailure(400, "Invalid branch name")).toBe("invalid_request");
  });

  it("maps 429 to quota_per_turn when the message names the per-turn cap", () => {
    expect(classifySpawnFailure(429, "Per-turn spawn limit reached (4).")).toBe("quota_per_turn");
  });

  it("maps 429 to quota_per_parent otherwise", () => {
    expect(
      classifySpawnFailure(429, "This session already has 16 spawned children (max 16)."),
    ).toBe("quota_per_parent");
  });

  it("falls back to error for any other status", () => {
    expect(classifySpawnFailure(500, "boom")).toBe("error");
    expect(classifySpawnFailure(0, "network")).toBe("error");
  });
});

describe("recordSpawnInvocation", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetSpawnTelemetry();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    resetSpawnTelemetry();
  });

  it("increments per-outcome, per-agent, per-parent, and per-turn counters", () => {
    recordSpawnInvocation({
      parentSessionId: "p1",
      spawnedByTurn: "turn-a",
      agentId: "claude",
      outcome: "success",
      statusCode: 200,
      childSessionId: "c1",
    });
    recordSpawnInvocation({
      parentSessionId: "p1",
      spawnedByTurn: "turn-a",
      agentId: "claude",
      outcome: "quota_per_turn",
      statusCode: 429,
      errorMessage: "Per-turn spawn limit",
    });
    recordSpawnInvocation({
      parentSessionId: "p2",
      agentId: "codex",
      outcome: "success",
      statusCode: 200,
      childSessionId: "c2",
    });

    const snap = getSpawnTelemetrySnapshot();
    expect(snap.total).toBe(3);
    expect(snap.byOutcome.success).toBe(2);
    expect(snap.byOutcome.quota_per_turn).toBe(1);
    expect(snap.byAgent.claude).toBe(2);
    expect(snap.byAgent.codex).toBe(1);
    expect(snap.byParent.p1).toBe(2);
    expect(snap.byParent.p2).toBe(1);
    expect(snap.byTurn["turn-a"]).toBe(2);
  });

  it("emits a structured `[spawn-telemetry]` log line per invocation", () => {
    recordSpawnInvocation({
      parentSessionId: "p1",
      spawnedByTurn: "turn-a",
      agentId: "claude",
      outcome: "success",
      statusCode: 200,
      childSessionId: "c1",
    });
    expect(logSpy).toHaveBeenCalledOnce();
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("[spawn-telemetry]");
    expect(line).toContain("outcome=success");
    expect(line).toContain("status=200");
    expect(line).toContain("parent=p1");
    expect(line).toContain("agent=claude");
    expect(line).toContain("turn=turn-a");
    expect(line).toContain("child=c1");
  });

  it("omits the turn field when no spawnedByTurn is supplied", () => {
    recordSpawnInvocation({
      parentSessionId: "p1",
      agentId: "claude",
      outcome: "success",
      statusCode: 200,
      childSessionId: "c1",
    });
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("turn=");
  });

  it("truncates oversize error messages to 200 chars", () => {
    const huge = "x".repeat(500);
    recordSpawnInvocation({
      parentSessionId: "p1",
      agentId: "claude",
      outcome: "error",
      statusCode: 500,
      errorMessage: huge,
    });
    const line = logSpy.mock.calls[0][0] as string;
    const match = /error="([^"]+)"/.exec(line);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(200);
  });
});

describe("resetSpawnTelemetry", () => {
  it("zeroes the counters", () => {
    recordSpawnInvocation({
      parentSessionId: "p1",
      agentId: "claude",
      outcome: "success",
      statusCode: 200,
    });
    expect(getSpawnTelemetrySnapshot().total).toBe(1);
    resetSpawnTelemetry();
    expect(getSpawnTelemetrySnapshot().total).toBe(0);
    expect(getSpawnTelemetrySnapshot().byOutcome.success).toBe(0);
  });
});
