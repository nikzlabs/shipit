import { describe, it, expect, vi } from "vitest";
import { ClaudeLimitsProvider } from "./limits-provider.js";
import type { AuthManager } from "./auth-manager.js";

/** docs/150 — every snapshot is now attributed to a route (account) id. */
const ROUTE = "acct-test";

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

    expect(provider.routeIds()).toEqual([]);
    expect(await provider.fetch(ROUTE)).toBeNull();

    provider.setRateLimits(
      { usedPct: 30, resetAt: "2026-06-01T00:00:00Z" },
      { usedPct: 12, resetAt: "2026-06-07T00:00:00Z" },
      ROUTE,
    );

    expect(provider.routeIds()).toEqual([ROUTE]);
    const snap = await provider.fetch(ROUTE);
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
      ROUTE,
    );
    const snap = await provider.fetch(ROUTE);
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
      ROUTE,
    );
    provider.setRateLimits(
      { usedPct: 80, resetAt: "2026-06-01T00:00:00Z" },
      null,
      ROUTE,
    );
    const snap = await provider.fetch(ROUTE);
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
      ROUTE,
    );

    await provider.refreshNow("manual", ROUTE);
    const snap = await provider.fetch(ROUTE);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(snap?.session?.usedPct).toBe(12);
    expect(snap?.session?.source).toBe("usage-api");
    expect(snap?.weekly?.usedPct).toBe(4);
  });

  it("reads a low session percentage as percent, not a 0–1 fraction", async () => {
    // Regression: /api/oauth/usage reports percent on a 0–100 scale. A session
    // reading of 1 means 1%, but a fraction heuristic (`<= 1 ? *100`) inflated
    // it to 100% — the badge showed "5h 100%" while native /usage showed 1%.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        five_hour: { utilization: 1, resets_at: "2026-06-01T00:00:00Z" },
        seven_day: { utilization: 0.4, resets_at: "2026-06-07T00:00:00Z" },
      }),
    );
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" }),
      fetchImpl,
    });
    await provider.refreshNow("manual", ROUTE);
    const snap = await provider.fetch(ROUTE);
    expect(snap?.session?.usedPct).toBe(1);
    expect(snap?.weekly?.usedPct).toBe(0.4);
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
    await provider.refreshNow("manual", ROUTE);
    // A later event with a real number should override the older API value.
    clock.mockReturnValue(2_000);
    provider.setRateLimits({ usedPct: 88, resetAt: "2026-06-01T00:00:00Z" }, null, ROUTE);
    const snap = await provider.fetch(ROUTE);
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
    await provider.refreshNow("manual", ROUTE);
    expect(fetchImpl).toHaveBeenCalledOnce();
    // Still locked → second manual refresh is a no-op (no new fetch).
    await provider.refreshNow("manual", ROUTE);
    expect(fetchImpl).toHaveBeenCalledOnce();
    // The snapshot carries lockedUntil so the client can disable the button.
    provider.setRateLimits({ usedPct: 1, resetAt: "2026-06-01T00:00:00Z" }, null, ROUTE);
    const snap = await provider.fetch(ROUTE);
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
    await provider.refreshNow("seed", ROUTE);
    await provider.refreshNow("seed", ROUTE);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("pins fetchedAt to the moment setRateLimits ran", async () => {
    const clock = vi.fn();
    clock.mockReturnValueOnce(1_700_000_000_000).mockReturnValueOnce(1_700_000_000_000);
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: null }),
      now: clock,
    });
    provider.setRateLimits({ usedPct: 1, resetAt: "2026-06-01T00:00:00Z" }, null, ROUTE);
    const snap = await provider.fetch(ROUTE);
    expect(snap?.fetchedAt).toBe(1_700_000_000_000);
  });
});

/**
 * docs/150 — the route id has to reach BOTH the enumeration and the token
 * lookup. These two bugs together produced the reported symptom: a pill stuck
 * at "—" whose refresh button did nothing.
 */
describe("ClaudeLimitsProvider account routing", () => {
  const okUsage = {
    ok: true,
    status: 200,
    json: async () => ({
      five_hour: { utilization: 40, resets_at: "2026-06-01T00:00:00Z" },
      seven_day: { utilization: 20, resets_at: "2026-06-07T00:00:00Z" },
    }),
  } as unknown as Response;

  it("can name a connected account before it has ever reported quota", async () => {
    // The bug: routeIds() returned only routes with a cached snapshot, so the
    // once-per-sign-in seed fetch iterated zero routes for a fresh account —
    // data was required in order to be allowed to fetch data.
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" }),
      listAccountRouteIds: () => ["acct-work", "acct-personal"],
    });

    expect(provider.routeIds().sort()).toEqual(["acct-personal", "acct-work"]);
  });

  it("still surfaces a cached reserved route that is not an account row", async () => {
    const provider = new ClaudeLimitsProvider({
      authManager: makeAuthStub({ token: "tok", source: "env", expiresAt: null, plan: null }),
      listAccountRouteIds: () => ["acct-work"],
    });
    provider.setRateLimits({ usedPct: 5, resetAt: "2026-06-01T00:00:00Z" }, null, "claude-env-oauth");

    expect(provider.routeIds().sort()).toEqual(["acct-work", "claude-env-oauth"]);
  });

  it("fetches each account's usage with THAT account's credentials", async () => {
    // The bug: `getAccessToken()` was called with no dir, so it preferred
    // ANTHROPIC_AUTH_TOKEN / the root config dir — reading the wrong
    // subscription's usage, or none at all.
    const getAccessToken = vi.fn().mockResolvedValue({
      token: "tok", source: "file", expiresAt: null, plan: "Pro",
    });
    const fetchImpl = vi.fn().mockResolvedValue(okUsage);
    const provider = new ClaudeLimitsProvider({
      authManager: { getAccessToken },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      listAccountRouteIds: () => ["acct-work"],
      credentialDirForRoute: (routeId) =>
        routeId === "acct-work" ? "/credentials/provider-accounts/claude/acct-work" : undefined,
    });

    await provider.refreshNow("manual", "acct-work");

    expect(getAccessToken).toHaveBeenCalledWith("/credentials/provider-accounts/claude/acct-work");
    const snap = await provider.fetch("acct-work");
    expect(snap?.session?.usedPct).toBe(40);
  });

  it("uses the env/legacy path for a reserved route, which has no account dir", async () => {
    const getAccessToken = vi.fn().mockResolvedValue({
      token: "tok", source: "env", expiresAt: null, plan: null,
    });
    const provider = new ClaudeLimitsProvider({
      authManager: { getAccessToken },
      fetchImpl: vi.fn().mockResolvedValue(okUsage) as unknown as typeof fetch,
      credentialDirForRoute: () => undefined,
    });

    await provider.refreshNow("manual", "claude-env-oauth");

    expect(getAccessToken).toHaveBeenCalledWith(undefined);
  });

  // docs/150 req 19 — `fetch()` reads the plan label through the same door.
  // It stayed unscoped after `doRefresh` was fixed, so each pill was labelled
  // with whatever the singleton root held: the migrated default's plan for
  // every account, and nothing at all once the aliases were retired.
  it("reads each account's plan label from that account's credentials", async () => {
    const getAccessToken = vi.fn().mockResolvedValue({
      token: "tok", source: "file", expiresAt: null, plan: "Max 20x",
    });
    const provider = new ClaudeLimitsProvider({
      authManager: { getAccessToken },
      fetchImpl: vi.fn().mockResolvedValue(okUsage) as unknown as typeof fetch,
      listAccountRouteIds: () => ["acct-work"],
      credentialDirForRoute: (routeId) =>
        routeId === "acct-work" ? "/credentials/provider-accounts/claude/acct-work" : undefined,
    });

    await provider.refreshNow("manual", "acct-work");
    getAccessToken.mockClear();

    const snap = await provider.fetch("acct-work");

    expect(getAccessToken).toHaveBeenCalledWith("/credentials/provider-accounts/claude/acct-work");
    expect(snap?.plan).toBe("Max 20x");
  });
});
