import { describe, expect, it } from "vitest";
import { normalizeAgentUsageLimitError } from "./agent-rate-limits.js";
import type { AgentId, SubscriptionLimits, SubscriptionLimitsMap, SubscriptionLimitsWindow } from "../../shared/types.js";

const snapshot = (agentId: AgentId, session: SubscriptionLimitsWindow | null): SubscriptionLimits => ({
  agentId,
  plan: null,
  session,
  weekly: null,
  fetchedAt: 0,
});

const limitsFor = (agentId: AgentId, session: SubscriptionLimitsWindow | null): SubscriptionLimitsMap => ({
  [agentId]: snapshot(agentId, session),
});

describe("normalizeAgentUsageLimitError", () => {
  it("leaves a non-usage-limit message untouched", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "network error", limits)).toBe("network error");
  });

  it("keeps the upstream text when there is no subscription snapshot", () => {
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", undefined)).toBe(
      "monthly usage limit reached",
    );
  });

  it("keeps the upstream text when the session window has no reported utilization (usedPct null)", () => {
    const limits = limitsFor("claude", { usedPct: null, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", limits)).toBe(
      "monthly usage limit reached",
    );
  });

  it("keeps the upstream text when the session window is not yet exhausted (usedPct < 100)", () => {
    const limits = limitsFor("claude", { usedPct: 80, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", limits)).toBe(
      "monthly usage limit reached",
    );
  });

  it("reclassifies to the 5h-window message when the session window is exhausted", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit reached", limits)).toBe(
      "You've hit Claude's 5h usage limit. It resets at 2026-06-16T05:00:00.000Z.",
    );
  });

  it("labels the agent by id (Codex) and normalizes the reset time to ISO", () => {
    const limits = limitsFor("codex", { usedPct: 100, resetAt: "2026-06-16T05:00:00.000Z" });
    expect(normalizeAgentUsageLimitError("codex", "Monthly Usage Limit", limits)).toBe(
      "You've hit Codex's 5h usage limit. It resets at 2026-06-16T05:00:00.000Z.",
    );
  });

  it("falls back to the raw resetAt string when it isn't a parseable date", () => {
    const limits = limitsFor("claude", { usedPct: 100, resetAt: "not-a-date" });
    expect(normalizeAgentUsageLimitError("claude", "monthly usage limit", limits)).toBe(
      "You've hit Claude's 5h usage limit. It resets at not-a-date.",
    );
  });
});
