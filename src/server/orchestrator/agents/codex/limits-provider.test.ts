import { describe, it, expect, vi } from "vitest";
import { CodexLimitsProvider } from "./limits-provider.js";
import type { CodexAuthManager } from "./auth-manager.js";

/** docs/150 — every snapshot is now attributed to a route (account) id. */
const ROUTE = "acct-test";

function makeAuthStub(
  result: Awaited<ReturnType<CodexAuthManager["getAccessToken"]>>,
): Pick<CodexAuthManager, "getAccessToken"> {
  return { getAccessToken: vi.fn().mockResolvedValue(result) };
}

const WINDOW = { usedPct: 30, resetAt: "2026-05-20T18:00:00Z" };
const WEEKLY = { usedPct: 10, resetAt: "2026-05-27T00:00:00Z" };

describe("CodexLimitsProvider (event-fed)", () => {
  it("is not fetchable until a rate-limit snapshot has been pushed", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Plus" });
    const provider = new CodexLimitsProvider({ codexAuthManager: auth });
    expect(provider.routeIds()).toEqual([]);
    expect(await provider.fetch(ROUTE)).toBeNull();
  });

  it("returns the pushed windows enriched with the auth-derived plan", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
    const provider = new CodexLimitsProvider({ codexAuthManager: auth, now: () => 42 });
    provider.setRateLimits(WINDOW, WEEKLY, ROUTE);
    expect(provider.routeIds()).toEqual([ROUTE]);
    const snap = await provider.fetch(ROUTE);
    expect(snap).toMatchObject({
      agentId: "codex",
      plan: "Pro",
      session: WINDOW,
      weekly: WEEKLY,
      fetchedAt: 42,
    });
  });

  it("renders usage without a plan tier when the token is gone", async () => {
    const auth = makeAuthStub({ token: null, reason: "not-authenticated" });
    const provider = new CodexLimitsProvider({ codexAuthManager: auth });
    provider.setRateLimits(WINDOW, null, ROUTE);
    const snap = await provider.fetch(ROUTE);
    expect(snap).toMatchObject({ agentId: "codex", plan: null, session: WINDOW, weekly: null });
  });

  it("keeps only the most recently pushed snapshot", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Plus" });
    const provider = new CodexLimitsProvider({ codexAuthManager: auth });
    provider.setRateLimits(WINDOW, WEEKLY, ROUTE);
    const newer = { usedPct: 55, resetAt: "2026-05-21T00:00:00Z" };
    provider.setRateLimits(newer, null, ROUTE);
    const snap = await provider.fetch(ROUTE);
    expect(snap).toMatchObject({ session: newer, weekly: null });
  });

  it("preserves the current window anchor when Codex moves its rolling reset forward", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Plus" });
    const now = Date.parse("2026-05-20T10:00:00Z");
    const provider = new CodexLimitsProvider({ codexAuthManager: auth, now: () => now });
    provider.setRateLimits(
      { usedPct: 10, resetAt: "2026-05-20T15:00:00Z", startedAt: "2026-05-20T10:00:00Z" },
      null,
      ROUTE,
    );
    provider.setRateLimits(
      { usedPct: 16, resetAt: "2026-05-20T16:00:00Z", startedAt: "2026-05-20T11:00:00Z" },
      null,
      ROUTE,
    );
    expect((await provider.fetch(ROUTE))?.session?.startedAt).toBe("2026-05-20T10:00:00Z");
  });
});
