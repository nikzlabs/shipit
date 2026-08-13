import { describe, it, expect } from "vitest";
import { CodexRateLimits } from "./codex-rate-limits.js";

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

  // planning#367 — the app-server's rollup is cumulative for the whole thread,
  // and `thread/resume` replays the previous turn's snapshot before the new turn
  // produces one. Both facts are measured against codex-cli 0.146.0.
  describe("per-turn attribution of a cumulative rollup", () => {
    const first = { total: { inputTokens: 1000, outputTokens: 10 }, last: { totalTokens: 1000 } };
    const second = { total: { inputTokens: 2000, outputTokens: 20 }, last: { totalTokens: 1000 } };

    it("makes the replayed snapshot the next turn's baseline", () => {
      const rl = new CodexRateLimits();
      // `thread/resume` replays turn 1's snapshot, carrying turn 1's id…
      rl.recordTokenUsage(first, "turn-1");
      // …then turn 2 reports the grown rollup under its own id.
      rl.recordTokenUsage(second, "turn-2");

      expect(rl.turnTokenUsage("turn-2")).toEqual({
        usage: second,
        baselineTotal: first.total,
      });
    });

    it("has no baseline for the first turn of a thread", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first, "turn-1");
      expect(rl.turnTokenUsage("turn-1")).toEqual({ usage: first, baselineTotal: undefined });
    });

    // The secondary defect: a turn that reported no usage of its own was handed
    // the replayed snapshot, recording the previous turn's cumulative total (and
    // its context occupancy) a second time.
    it("refuses a snapshot belonging to another turn", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first, "turn-1");
      expect(rl.turnTokenUsage("turn-2")).toBeNull();
      // …while the raw snapshot stays available for the context-occupancy
      // readers that legitimately want the latest one (compaction pre/post).
      expect(rl.lastTokenUsage).toEqual(first);
    });

    it("keeps the pre-turnId behaviour when the app-server sends no turn id", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first);
      expect(rl.turnTokenUsage("turn-1")).toEqual({ usage: first, baselineTotal: undefined });
    });

    // An EMPTY turn id is not a missing one. codex-cli 0.146.0 replays usage
    // under `turnId: ""` when it cannot associate persisted usage with a
    // rebuilt turn, so a truthiness test would read the replay as "no id known"
    // and hand the previous thread's whole rollup to a turn that reported
    // nothing of its own.
    it("refuses a replay whose turn id is empty", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first, "");
      expect(rl.turnTokenUsage("turn-2")).toBeNull();
    });

    it("still takes an empty-id replay as the next turn's baseline", () => {
      const rl = new CodexRateLimits();
      rl.recordTokenUsage(first, "");
      rl.recordTokenUsage(second, "turn-2");
      expect(rl.turnTokenUsage("turn-2")).toEqual({ usage: second, baselineTotal: first.total });
    });
  });
});
