import { describe, it, expect, vi } from "vitest";
import { CodexLimitsProvider } from "./limits-provider.js";
import type { CodexAuthManager } from "./auth-manager.js";

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
    expect(provider.canFetch()).toBe(false);
    expect(await provider.fetch()).toBeNull();
  });

  it("returns the pushed windows enriched with the auth-derived plan", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
    const provider = new CodexLimitsProvider({ codexAuthManager: auth, now: () => 42 });
    provider.setRateLimits(WINDOW, WEEKLY);
    expect(provider.canFetch()).toBe(true);
    const snap = await provider.fetch();
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
    provider.setRateLimits(WINDOW, null);
    const snap = await provider.fetch();
    expect(snap).toMatchObject({ agentId: "codex", plan: null, session: WINDOW, weekly: null });
  });

  it("keeps only the most recently pushed snapshot", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Plus" });
    const provider = new CodexLimitsProvider({ codexAuthManager: auth });
    provider.setRateLimits(WINDOW, WEEKLY);
    const newer = { usedPct: 55, resetAt: "2026-05-21T00:00:00Z" };
    provider.setRateLimits(newer, null);
    const snap = await provider.fetch();
    expect(snap).toMatchObject({ session: newer, weekly: null });
  });
});
