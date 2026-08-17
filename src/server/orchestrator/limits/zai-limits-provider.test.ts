import { describe, it, expect, vi } from "vitest";
import { ZaiLimitsProvider, parseZaiQuota, ZAI_QUOTA_URL } from "./zai-limits-provider.js";

const ROUTE = "cred_glm";
const NOW = Date.parse("2026-06-01T00:00:00Z");
const HOUR = 60 * 60_000;

/** A well-formed envelope: a 5h window 2h out, a weekly window 3 days out. */
function goodBody(sessionPct = 42, weeklyPct = 7): unknown {
  return {
    code: 200,
    success: true,
    data: {
      limits: [
        { unit: 1, usage: sessionPct, resetTime: new Date(NOW + 2 * HOUR).toISOString() },
        { unit: 2, usage: weeklyPct, resetTime: new Date(NOW + 72 * HOUR).toISOString() },
      ],
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeProvider(opts: {
  fetchImpl?: typeof fetch;
  secret?: string | undefined;
  routes?: string[];
} = {}) {
  return new ZaiLimitsProvider({
    listRouteIds: () => opts.routes ?? [ROUTE],
    secretForRoute: () => ("secret" in opts ? opts.secret : "zai-key"),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    now: () => NOW,
  });
}

describe("parseZaiQuota", () => {
  it("reads the documented envelope into a session and a weekly window", () => {
    const parsed = parseZaiQuota(goodBody(), NOW);
    expect(parsed?.session).toEqual({ usedPct: 42, resetAt: new Date(NOW + 2 * HOUR).toISOString() });
    expect(parsed?.weekly).toEqual({ usedPct: 7, resetAt: new Date(NOW + 72 * HOUR).toISOString() });
  });

  it("classifies by reset horizon, not by the unit field", () => {
    // `unit` deliberately reversed against the horizons: community reports say
    // the field distinguishes the windows but not which value means which, so
    // trusting it is what would swap the meters.
    const parsed = parseZaiQuota(
      {
        data: {
          limits: [
            { unit: 2, usage: 90, resetTime: new Date(NOW + HOUR).toISOString() },
            { unit: 1, usage: 10, resetTime: new Date(NOW + 100 * HOUR).toISOString() },
          ],
        },
      },
      NOW,
    );
    expect(parsed?.session?.usedPct).toBe(90);
    expect(parsed?.weekly?.usedPct).toBe(10);
  });

  it("accepts a flatter envelope and epoch-second reset times", () => {
    const parsed = parseZaiQuota(
      { limits: [{ usage: 55, reset_time: Math.floor((NOW + 3 * HOUR) / 1000) }] },
      NOW,
    );
    expect(parsed?.session).toEqual({ usedPct: 55, resetAt: new Date(NOW + 3 * HOUR).toISOString() });
    expect(parsed?.weekly).toBeNull();
  });

  // ---- Fail-closed rules. Each of these would otherwise render a number
  // ---- nobody measured, which req 10 prefers an empty pill to.

  it("reports nothing when both entries land in the same horizon bucket", () => {
    // Ambiguous: the horizon rule cannot say which of these is the 5h window,
    // and picking one is a coin flip presented as a measurement.
    expect(
      parseZaiQuota(
        {
          data: {
            limits: [
              { usage: 20, resetTime: new Date(NOW + HOUR).toISOString() },
              { usage: 80, resetTime: new Date(NOW + 2 * HOUR).toISOString() },
            ],
          },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("keeps the unambiguous bucket when only the other one is ambiguous", () => {
    const parsed = parseZaiQuota(
      {
        data: {
          limits: [
            { usage: 20, resetTime: new Date(NOW + HOUR).toISOString() },
            { usage: 80, resetTime: new Date(NOW + 2 * HOUR).toISOString() },
            { usage: 5, resetTime: new Date(NOW + 96 * HOUR).toISOString() },
          ],
        },
      },
      NOW,
    );
    expect(parsed?.session).toBeNull();
    expect(parsed?.weekly?.usedPct).toBe(5);
  });

  it("rejects a percentage outside 0-100 rather than clamping it", () => {
    // The likely misread: `usage` is a token count, not a percent. Clamping
    // would paint a full bar over an untouched plan.
    expect(
      parseZaiQuota({ data: { limits: [{ usage: 184_320, resetTime: new Date(NOW + HOUR).toISOString() }] } }, NOW),
    ).toBeNull();
  });

  it("drops an entry that has a reset time but no readable percentage", () => {
    expect(
      parseZaiQuota({ data: { limits: [{ resetTime: new Date(NOW + HOUR).toISOString() }] } }, NOW),
    ).toBeNull();
  });

  it("drops an entry that has a percentage but no readable reset time", () => {
    expect(parseZaiQuota({ data: { limits: [{ usage: 33 }] } }, NOW)).toBeNull();
  });

  it("drops a window whose reset has already passed", () => {
    expect(
      parseZaiQuota(
        { data: { limits: [{ usage: 33, resetTime: new Date(NOW - HOUR).toISOString() }] } },
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores a reset beyond a week instead of filing it as the weekly window", () => {
    expect(
      parseZaiQuota(
        { data: { limits: [{ usage: 33, resetTime: new Date(NOW + 40 * 24 * HOUR).toISOString() }] } },
        NOW,
      ),
    ).toBeNull();
  });

  it("reports nothing for an explicit failure envelope", () => {
    expect(parseZaiQuota({ success: false, data: { limits: [] } }, NOW)).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "not json"],
    ["an empty object", {}],
    ["limits that is not an array", { data: { limits: { usage: 10 } } }],
    ["an empty limits array", { data: { limits: [] } }],
    ["entries that are not objects", { data: { limits: [1, "x", null] } }],
  ])("reports nothing for %s", (_label, body) => {
    expect(parseZaiQuota(body, NOW)).toBeNull();
  });
});

describe("ZaiLimitsProvider", () => {
  it("declares the (service, billing mode) the registry indexes it by", () => {
    const provider = makeProvider();
    expect(provider.serviceId).toBe("zai");
    expect(provider.billingMode).toBe("sub");
  });

  it("names every configured credential, and nothing before a reading exists", async () => {
    const provider = makeProvider({ routes: [ROUTE, "cred_glm_2"] });
    expect(provider.routeIds()).toEqual([ROUTE, "cred_glm_2"]);
    expect(await provider.fetch(ROUTE)).toBeNull();
  });

  it("fetches the quota endpoint with the route's key as a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(goodBody()));
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await provider.refreshNow("seed", ROUTE)).toEqual({ routeId: ROUTE, outcome: "updated" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ZAI_QUOTA_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer zai-key");

    const snap = await provider.fetch(ROUTE);
    expect(snap?.serviceId).toBe("zai");
    expect(snap?.billingMode).toBe("sub");
    expect(snap?.routeId).toBe(ROUTE);
    expect(snap?.session?.usedPct).toBe(42);
    expect(snap?.weekly?.usedPct).toBe(7);
    // No tier name is trustworthy in this payload, so none is invented.
    expect(snap?.plan).toBeNull();
  });

  it("records no snapshot at all when the payload is unrecognised", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { limits: [{ tokens: 5 }] } }));
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.refreshNow("manual", ROUTE);
    expect(result.outcome).toBe("failed");
    // The failure that matters: not a zeroed pair of meters.
    expect(await provider.fetch(ROUTE)).toBeNull();
  });

  it("reports no-credentials rather than calling out with no key", async () => {
    const fetchImpl = vi.fn();
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch, secret: undefined });
    expect((await provider.refreshNow("manual", ROUTE)).outcome).toBe("no-credentials");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a rejected key as no-credentials, so the button says 'replace it'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await provider.refreshNow("manual", ROUTE)).outcome).toBe("no-credentials");
  });

  it("survives a network error and a non-JSON body without throwing", async () => {
    const boom = makeProvider({
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch,
    });
    expect((await boom.refreshNow("manual", ROUTE)).outcome).toBe("failed");

    const garbage = makeProvider({
      fetchImpl: vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect((await garbage.refreshNow("manual", ROUTE)).outcome).toBe("failed");
    expect(await garbage.fetch(ROUTE)).toBeNull();
  });

  it("locks out after a 429 and surfaces the countdown on the snapshot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "120" } }),
    );
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const first = await provider.refreshNow("manual", ROUTE);
    expect(first.outcome).toBe("rate-limited");
    expect(first.lockedUntil).toBe(NOW + 120_000);

    // A route with no reading but an active lockout still owes the countdown.
    expect((await provider.fetch(ROUTE))?.lockedUntil).toBe(NOW + 120_000);

    const second = await provider.refreshNow("manual", ROUTE);
    expect(second.outcome).toBe("locked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips a seed once a reading exists, but a manual press always attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(goodBody()));
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await provider.refreshNow("seed", ROUTE);
    expect(await provider.refreshNow("seed", ROUTE)).toEqual({ routeId: ROUTE, outcome: "skipped" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await provider.refreshNow("manual", ROUTE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent refreshes of the same route", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(goodBody()));
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const [a, b] = await Promise.all([
      provider.refreshNow("manual", ROUTE),
      provider.refreshNow("manual", ROUTE),
    ]);
    expect(a.outcome).toBe("updated");
    expect(b.outcome).toBe("updated");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("discards a response that started before the credential changed", async () => {
    let release!: (value: Response) => void;
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const pending = provider.refreshNow("manual", ROUTE);
    provider.forgetRoute(ROUTE);
    release(jsonResponse(goodBody()));

    expect((await pending).outcome).toBe("skipped");
    expect(await provider.fetch(ROUTE)).toBeNull();
  });

  it("forgetRoute drops the reading, so a deleted credential loses its pill", async () => {
    const provider = makeProvider({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(goodBody())) as unknown as typeof fetch,
    });
    await provider.refreshNow("seed", ROUTE);
    expect(await provider.fetch(ROUTE)).not.toBeNull();

    provider.forgetRoute(ROUTE);
    expect(await provider.fetch(ROUTE)).toBeNull();
  });

  it("keeps a harness-pushed reading, preferring whichever source is fresher", async () => {
    // Nothing is known to push one for a GLM credential, but a reading that
    // does arrive is real, and dropping it would be a lie of omission.
    let clock = NOW;
    const provider = new ZaiLimitsProvider({
      listRouteIds: () => [ROUTE],
      secretForRoute: () => "zai-key",
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(goodBody(42, 7))) as unknown as typeof fetch,
      now: () => clock,
    });

    await provider.refreshNow("seed", ROUTE);
    expect((await provider.fetch(ROUTE))?.session?.usedPct).toBe(42);

    clock = NOW + 60_000;
    provider.setRateLimits(
      { usedPct: 61, resetAt: new Date(NOW + HOUR).toISOString() },
      null,
      ROUTE,
    );
    const snap = await provider.fetch(ROUTE);
    expect(snap?.session?.usedPct).toBe(61);
    expect(snap?.fetchedAt).toBe(NOW + 60_000);
  });
});
