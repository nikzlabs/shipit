import { describe, it, expect } from "vitest";
import { CodexRateLimits } from "./codex-rate-limits.js";
import { codexTurnTokens, type CodexReportedTokens } from "../../../shared/codex-token-usage.js";

describe("CodexRateLimits", () => {
  describe("updateRateLimits", () => {
    it("maps windows by duration to an agent_rate_limits event", () => {
      const rl = new CodexRateLimits();
      const event = rl.updateRateLimits({
        rateLimits: {
          primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1779296611 },
          secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1779883011 },
        },
      });
      expect(event).toEqual({
        type: "agent_rate_limits",
        session: {
          usedPct: 5,
          resetAt: new Date(1779296611 * 1000).toISOString(),
          startedAt: new Date((1779296611 - 300 * 60) * 1000).toISOString(),
        },
        weekly: {
          usedPct: 1,
          resetAt: new Date(1779883011 * 1000).toISOString(),
          startedAt: new Date((1779883011 - 10080 * 60) * 1000).toISOString(),
        },
      });
    });

    it("keeps a lone weekly primary window out of the 5h slot", () => {
      const rl = new CodexRateLimits();
      const resetAt = 1779883011;
      const event = rl.updateRateLimits({
        rateLimits: {
          primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: resetAt },
        },
      });

      expect(event).toEqual({
        type: "agent_rate_limits",
        session: null,
        weekly: {
          usedPct: 23,
          resetAt: new Date(resetAt * 1000).toISOString(),
          startedAt: new Date((resetAt - 10080 * 60) * 1000).toISOString(),
        },
      });
    });

    it("uses durations rather than primary/secondary ordering", () => {
      const rl = new CodexRateLimits();
      const event = rl.updateRateLimits({
        rateLimits: {
          primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1779883011 },
          secondary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1779296611 },
        },
      });

      expect(event).toMatchObject({
        session: { usedPct: 41 },
        weekly: { usedPct: 23 },
      });
    });

    it("returns null when neither window parses", () => {
      const rl = new CodexRateLimits();
      expect(rl.updateRateLimits({ rateLimits: { limitId: "codex", limitName: null } })).toBeNull();
      expect(rl.updateRateLimits({})).toBeNull();
    });

    it("clamps usedPercent into 0–100 and tolerates a ms resetsAt", () => {
      const rl = new CodexRateLimits();
      const event = rl.updateRateLimits({
        rateLimits: { primary: { usedPercent: 140, resetsAt: 1779296611000 } },
      }) as { session: { usedPct: number; resetAt: string }; weekly: null };
      expect(event.session.usedPct).toBe(100);
      expect(event.session.resetAt).toBe(new Date(1779296611000).toISOString());
      expect(event.weekly).toBeNull();
    });
  });

  describe("normalizeJsonRpcError", () => {
    it("rewrites a monthly-limit message when the 5h window is exhausted", () => {
      const rl = new CodexRateLimits();
      rl.updateRateLimits({
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: 1779296611 },
          secondary: { usedPercent: 12, resetsAt: 1779883011 },
        },
      });
      const out = rl.normalizeJsonRpcError("You've hit your org's monthly usage limit");
      expect(out).toContain("Codex's 5h usage limit");
      expect(out).toContain(new Date(1779296611 * 1000).toISOString());
      expect(out).not.toContain("monthly usage limit");
    });

    it("leaves the message unchanged when the 5h window is not exhausted", () => {
      const rl = new CodexRateLimits();
      rl.updateRateLimits({ rateLimits: { primary: { usedPercent: 40, resetsAt: 1779296611 } } });
      const msg = "You've hit your org's monthly usage limit";
      expect(rl.normalizeJsonRpcError(msg)).toBe(msg);
    });

    it("passes through unrelated errors verbatim", () => {
      const rl = new CodexRateLimits();
      expect(rl.normalizeJsonRpcError("invalid type: string")).toBe("invalid type: string");
    });
  });

  describe("recordTokenUsage", () => {
    it("stores the latest snapshot and keeps the prior one on a null update", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage({ last: { totalTokens: 130 }, modelContextWindow: 272000 });
      expect(rl.lastTokenUsage?.last?.totalTokens).toBe(130);
      rl.recordTokenUsage(undefined);
      expect(rl.lastTokenUsage?.last?.totalTokens).toBe(130);
    });
  });

  describe("per-turn attribution of a cumulative rollup", () => {
    const first = { total: { inputTokens: 1000, outputTokens: 10 }, last: { totalTokens: 1000 } };
    const second = { total: { inputTokens: 2000, outputTokens: 20 }, last: { totalTokens: 1000 } };

    it("makes the replayed snapshot the next turn's baseline", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first, "turn-1");
      rl.recordTokenUsage(second, "turn-2");

      expect(rl.turnTokenUsage("turn-2")).toEqual({
        usage: second,
        baselineTotal: first.total,
        requests: [],
      });
    });

    it("has no baseline for the first turn of a thread", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first, "turn-1");
      expect(rl.turnTokenUsage("turn-1")).toEqual({ usage: first, baselineTotal: undefined, requests: [] });
    });

    it("refuses a snapshot belonging to another turn", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first, "turn-1");
      expect(rl.turnTokenUsage("turn-2")).toBeNull();
      expect(rl.lastTokenUsage).toEqual(first);
    });

    it("keeps the pre-turnId behaviour when the app-server sends no turn id", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first);
      expect(rl.turnTokenUsage("turn-1")).toEqual({ usage: first, baselineTotal: undefined, requests: [] });
    });

    it("refuses a replay whose turn id is empty", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first, "");
      expect(rl.turnTokenUsage("turn-2")).toBeNull();
    });

    it("still takes an empty-id replay as the next turn's baseline", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first, "");
      rl.recordTokenUsage(second, "turn-2");
      expect(rl.turnTokenUsage("turn-2")).toEqual({ usage: second, baselineTotal: first.total, requests: [] });
    });
  });

  describe("per-response usage (docs/329-tiered-model-pricing)", () => {
    // inputTokens includes both cache portions, as on the wire.
    const response = (input: number, cached: number, output: number) => ({
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      totalTokens: input + output,
    });
    const update = (total: CodexReportedTokens, last: ReturnType<typeof response>) => ({ total, last });

    it("lists each response of this turn and leaves out the resume replay, within the totals", () => {
      const rl = new CodexRateLimits();
      const replayTotal = { inputTokens: 5_000, cachedInputTokens: 4_000, outputTokens: 100 };
      rl.recordTokenUsage(update(replayTotal, response(5_000, 4_000, 100)), "turn-1");
      const afterFirst = { inputTokens: 125_000, cachedInputTokens: 104_000, outputTokens: 400 };
      rl.recordTokenUsage(update(afterFirst, response(120_000, 100_000, 300)), "turn-2");
      const afterSecond = { inputTokens: 255_000, cachedInputTokens: 224_000, outputTokens: 900 };
      rl.recordTokenUsage(update(afterSecond, response(130_000, 120_000, 500)), "turn-2");

      const turn = rl.turnTokenUsage("turn-2")!;
      expect(turn.requests).toEqual([
        { input: 20_000, cacheRead: 100_000, output: 300 },
        { input: 10_000, cacheRead: 120_000, output: 500 },
      ]);
      const totals = codexTurnTokens(turn.usage.total, turn.baselineTotal)!;
      const sum = (field: "input" | "output" | "cacheRead") =>
        turn.requests.reduce((n, r) => n + (r[field] ?? 0), 0);
      expect(sum("input")).toBeLessThanOrEqual(totals.input);
      expect(sum("output")).toBeLessThanOrEqual(totals.output);
      expect(sum("cacheRead")).toBeLessThanOrEqual(totals.cacheRead ?? 0);
    });
  });
});
