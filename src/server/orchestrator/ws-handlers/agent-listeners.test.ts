import { describe, expect, it } from "vitest";
import { normalizeAgentUsageLimitError } from "./agent-listeners.js";
import type { SubscriptionLimitsMap } from "../../shared/types.js";

describe("normalizeAgentUsageLimitError", () => {
  it("rewrites misleading Claude monthly-limit errors when the 5h window is exhausted", () => {
    const resetAt = "2026-05-23T18:00:00.000Z";
    const limits: SubscriptionLimitsMap = {
      claude: {
        agentId: "claude",
        plan: "Max 20x",
        session: { usedPct: 100, resetAt },
        weekly: { usedPct: 40, resetAt: "2026-05-27T18:00:00.000Z" },
        fetchedAt: 1,
      },
    };

    expect(
      normalizeAgentUsageLimitError(
        "claude",
        "You've hit your org's monthly usage limit",
        limits,
      ),
    ).toBe(`You've hit Claude's 5h usage limit. It resets at ${resetAt}.`);
  });

  it("keeps monthly-limit errors unchanged without an exhausted 5h snapshot", () => {
    const limits: SubscriptionLimitsMap = {
      claude: {
        agentId: "claude",
        plan: "Max 20x",
        session: { usedPct: 88, resetAt: "2026-05-23T18:00:00.000Z" },
        weekly: null,
        fetchedAt: 1,
      },
    };

    const message = "You've hit your org's monthly usage limit";
    expect(normalizeAgentUsageLimitError("claude", message, limits)).toBe(message);
    expect(normalizeAgentUsageLimitError("claude", message, {})).toBe(message);
  });
});
