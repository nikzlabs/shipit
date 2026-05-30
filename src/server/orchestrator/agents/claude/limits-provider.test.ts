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

  function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  it("refreshNow fills the low-usage number the event stream omits", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        five_hour: { utilization: 12, resets_at: "2026-06-01T00:00:00Z" },
        seven_day: { utilization: 4, resets_at: "2026-06-07T00:00:00Z" },
      }),
    );
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" }),
      fetchImpl,
    });
    // Event stream reported the windows but no utilization (low usage).
    provider.setRateLimits(
      { usedPct: null, resetAt: "2026-06-01T00:00:00Z" },
      { usedPct: null, resetAt: "2026-06-07T00:00:00Z" },
    );

    await provider.refreshNow("manual");
    const snap = await provider.fetch();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(snap?.session?.usedPct).toBe(12);
    expect(snap?.session?.source).toBe("usage-api");
    expect(snap?.weekly?.usedPct).toBe(4);
  });

  it("a live event number wins over the API number", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ five_hour: { utilization: 12, resets_at: "2026-06-01T00:00:00Z" } }),
    );
    const clock = vi.fn(() => 1_000);
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" }),
      fetchImpl,
      now: clock,
    });
    await provider.refreshNow("manual");
    // A later event with a real number should override the older API value.
    clock.mockReturnValue(2_000);
    provider.setRateLimits({ usedPct: 88, resetAt: "2026-06-01T00:00:00Z" }, null);
    const snap = await provider.fetch();
    expect(snap?.session?.usedPct).toBe(88);
    expect(snap?.session?.source).toBe("event");
  });

  it("locks out after a 429 and skips further fetches until it elapses", async () => {
    const clock = vi.fn(() => 0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }));
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" }),
      fetchImpl,
      now: clock,
    });
    await provider.refreshNow("manual");
    expect(fetchImpl).toHaveBeenCalledOnce();
    // Still locked → second manual refresh is a no-op (no new fetch).
    await provider.refreshNow("manual");
    expect(fetchImpl).toHaveBeenCalledOnce();
    // The snapshot carries lockedUntil so the client can disable the button.
    provider.setRateLimits({ usedPct: 1, resetAt: "2026-06-01T00:00:00Z" }, null);
    const snap = await provider.fetch();
    expect(snap?.lockedUntil).toBeGreaterThan(0);
  });

  it("seed self-skips once an API snapshot exists", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ five_hour: { utilization: 7, resets_at: "2026-06-01T00:00:00Z" } }),
    );
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" }),
      fetchImpl,
    });
    await provider.refreshNow("seed");
    await provider.refreshNow("seed");
    expect(fetchImpl).toHaveBeenCalledOnce();
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
