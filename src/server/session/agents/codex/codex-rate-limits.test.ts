import { describe, it, expect } from "vitest";
import { CodexRateLimits } from "./codex-rate-limits.js";

describe("CodexRateLimits", () => {
  describe("updateRateLimits", () => {
    it("maps primary/secondary windows to an agent_rate_limits event", () => {
      const rl = new CodexRateLimits();
      const event = rl.updateRateLimits({
        rateLimits: {
          primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1779296611 },
          secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1779883011 },
        },
      });
      expect(event).toEqual({
        type: "agent_rate_limits",
        session: { usedPct: 5, resetAt: new Date(1779296611 * 1000).toISOString() },
        weekly: { usedPct: 1, resetAt: new Date(1779883011 * 1000).toISOString() },
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
});
