import { describe, it, expect, vi } from "vitest";
import { ClaudeLimitsProvider } from "./limits-provider.js";
import type { AuthManager } from "./auth-manager.js";

function makeAuthStub(
  result: Awaited<ReturnType<AuthManager["getAccessToken"]>>,
): Pick<AuthManager, "getAccessToken"> {
  return { getAccessToken: vi.fn().mockResolvedValue(result) };
}

describe("ClaudeLimitsProvider", () => {
  it("starts unfetchable; canFetch flips true once setRateLimits lands", async () => {
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Max 20x" }),
    });

    expect(provider.canFetch()).toBe(false);
    expect(await provider.fetch()).toBeNull();

    provider.setRateLimits(
      { usedPct: 30, resetAt: "2026-06-01T00:00:00Z" },
      { usedPct: 12, resetAt: "2026-06-07T00:00:00Z" },
    );

    expect(provider.canFetch()).toBe(true);
    const snap = await provider.fetch();
    expect(snap).not.toBeNull();
    expect(snap?.agentId).toBe("claude");
    expect(snap?.plan).toBe("Max 20x");
    expect(snap?.session?.usedPct).toBe(30);
    expect(snap?.weekly?.usedPct).toBe(12);
  });

  it("derives plan tier from the auth manager and tolerates a missing token", async () => {
    // No credentials → plan is null but the windows still render.
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: null, reason: "not-authenticated" }),
    });
    provider.setRateLimits(
      { usedPct: 5, resetAt: "2026-06-01T00:00:00Z" },
      null,
    );
    const snap = await provider.fetch();
    expect(snap?.plan).toBeNull();
    expect(snap?.session?.usedPct).toBe(5);
    expect(snap?.weekly).toBeNull();
  });

  it("setRateLimits replaces the cached snapshot (no merge across calls)", async () => {
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" }),
    });
    provider.setRateLimits(
      { usedPct: 10, resetAt: "2026-06-01T00:00:00Z" },
      { usedPct: 20, resetAt: "2026-06-07T00:00:00Z" },
    );
    provider.setRateLimits(
      { usedPct: 80, resetAt: "2026-06-01T00:00:00Z" },
      null,
    );
    const snap = await provider.fetch();
    expect(snap?.session?.usedPct).toBe(80);
    // Adapter is responsible for accumulating partial updates; the provider
    // just stores whatever was last pushed.
    expect(snap?.weekly).toBeNull();
  });

  it("pins fetchedAt to the moment setRateLimits ran", async () => {
    const clock = vi.fn();
    clock.mockReturnValueOnce(1_700_000_000_000).mockReturnValueOnce(1_700_000_000_000);
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: null }),
      now: clock,
    });
    provider.setRateLimits({ usedPct: 1, resetAt: "2026-06-01T00:00:00Z" }, null);
    const snap = await provider.fetch();
    expect(snap?.fetchedAt).toBe(1_700_000_000_000);
  });
});
