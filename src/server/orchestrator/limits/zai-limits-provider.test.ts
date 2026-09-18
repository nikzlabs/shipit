import { describe, it, expect, vi } from "vitest";
import { ZaiLimitsProvider, parseZaiQuota, ZAI_QUOTA_URL } from "./zai-limits-provider.js";

const ROUTE = "cred_glm";
const NOW = Date.parse("2026-08-17T17:30:00Z");
const HOUR = 60 * 60_000;

// Based on a coding-plan response captured from api.z.ai on 2026-08-17.
const MEASURED = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    level: "lite",
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 2000,
        currentValue: 0,
        remaining: 1999,
        percentage: 1,
        nextResetTime: NOW + 5 * HOUR,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 10000,
        currentValue: 789,
        remaining: 9210,
        percentage: 7,
        nextResetTime: NOW + 116 * HOUR,
      },
    ],
  },
};

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

describe("parseZaiQuota — against the payload Z.ai actually returns", () => {
  it("reads the measured envelope into both windows and the plan tier", () => {
    const parsed = parseZaiQuota(MEASURED, NOW);
    expect(parsed).toEqual({
      session: {
        usedPct: 0.05,
        resetAt: new Date(NOW + 5 * HOUR).toISOString(),
        startedAt: new Date(NOW).toISOString(),
      },
      weekly: {
        usedPct: 7.9,
        resetAt: new Date(NOW + 116 * HOUR).toISOString(),
        startedAt: new Date(NOW + 116 * HOUR - 7 * 24 * HOUR).toISOString(),
      },
      plan: "Lite",
      windows: ["session", "weekly"],
    });
  });

  it("still names a window whose two candidate entries could not be told apart", () => {
    const twoSessions = {
      data: {
        level: "lite",
        limits: [
          { unit: 3, number: 5, usage: 2000, remaining: 1999, nextResetTime: NOW + 5 * HOUR },
          { unit: 3, number: 5, usage: 3000, remaining: 2000, nextResetTime: NOW + 4 * HOUR },
          MEASURED.data.limits[1],
        ],
      },
    };
    const parsed = parseZaiQuota(twoSessions, NOW);
    expect(parsed?.session).toBeNull();
    expect(parsed?.windows).toEqual(["session", "weekly"]);
  });

  it("treats `usage` as the allowance, never as a percentage", () => {
    const parsed = parseZaiQuota(MEASURED, NOW);
    expect(parsed?.session?.usedPct).toBe(0.05);
    expect(parsed?.session?.usedPct).not.toBe(100);
  });

  it("ignores `currentValue`, which lags `remaining` inside one entry", () => {
    const parsed = parseZaiQuota(MEASURED, NOW);
    expect(parsed?.session?.usedPct).toBeGreaterThan(0);
  });

  it("falls back to `percentage` only when `remaining` is unusable", () => {
    const parsed = parseZaiQuota(
      { data: { limits: [{ unit: 3, number: 5, percentage: 42, nextResetTime: NOW + HOUR }] } },
      NOW,
    );
    expect(parsed?.session?.usedPct).toBe(42);
  });

  it("reports no window for a 5h allowance nothing has opened yet", () => {
    const unopened = {
      data: {
        level: "lite",
        limits: [
          { unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 },
          MEASURED.data.limits[1],
        ],
      },
    };
    const parsed = parseZaiQuota(unopened, NOW);
    expect(parsed?.session).toBeNull();
    expect(parsed?.weekly?.usedPct).toBe(7.9);
  });

  it("places a window of UNRECOGNISED `unit` by its reset horizon, with no startedAt", () => {
    const parsed = parseZaiQuota(
      {
        data: {
          limits: [
            { unit: 99, usage: 100, remaining: 90, nextResetTime: NOW + 2 * HOUR },
            { unit: 98, usage: 100, remaining: 50, nextResetTime: NOW + 72 * HOUR },
          ],
        },
      },
      NOW,
    );
    expect(parsed?.session).toEqual({ usedPct: 10, resetAt: new Date(NOW + 2 * HOUR).toISOString() });
    expect(parsed?.weekly?.usedPct).toBe(50);
  });

  it("trusts a DECLARED long window even when its reset is imminent", () => {
    const parsed = parseZaiQuota(
      { data: { limits: [{ unit: 3, number: 168, usage: 100, remaining: 40, nextResetTime: NOW + 2 * HOUR }] } },
      NOW,
    );
    expect(parsed?.session).toBeNull();
    expect(parsed?.weekly?.usedPct).toBe(60);
  });

  it("rejects a `remaining` outside [0, usage] rather than clamping it", () => {
    expect(
      parseZaiQuota({ data: { limits: [{ unit: 3, number: 5, usage: 2000, remaining: 5000, nextResetTime: NOW + HOUR }] } }, NOW),
    ).toBeNull();
  });

  it("rejects a `percentage` outside 0-100 rather than clamping it", () => {
    expect(
      parseZaiQuota({ data: { limits: [{ unit: 3, number: 5, percentage: 184_320, nextResetTime: NOW + HOUR }] } }, NOW),
    ).toBeNull();
  });

  it("reports nothing when two entries land in the same slot", () => {
    expect(
      parseZaiQuota(
        {
          data: {
            limits: [
              { unit: 3, number: 5, usage: 100, remaining: 80, nextResetTime: NOW + HOUR },
              { unit: 3, number: 5, usage: 100, remaining: 20, nextResetTime: NOW + 2 * HOUR },
            ],
          },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("keeps the unambiguous slot when only the other one is ambiguous", () => {
    const parsed = parseZaiQuota(
      {
        data: {
          limits: [
            { unit: 3, number: 5, usage: 100, remaining: 80, nextResetTime: NOW + HOUR },
            { unit: 3, number: 5, usage: 100, remaining: 20, nextResetTime: NOW + 2 * HOUR },
            { unit: 6, number: 1, usage: 100, remaining: 95, nextResetTime: NOW + 96 * HOUR },
          ],
        },
      },
      NOW,
    );
    expect(parsed?.session).toBeNull();
    expect(parsed?.weekly?.usedPct).toBe(5);
  });

  it("drops an entry with a reset that has already passed", () => {
    expect(
      parseZaiQuota({ data: { limits: [{ unit: 3, number: 5, usage: 100, remaining: 50, nextResetTime: NOW - HOUR }] } }, NOW),
    ).toBeNull();
  });

  it("drops a horizon-placed window beyond a week instead of filing it as 7d", () => {
    expect(
      parseZaiQuota({ data: { limits: [{ usage: 100, remaining: 50, nextResetTime: NOW + 40 * 24 * HOUR }] } }, NOW),
    ).toBeNull();
  });

  it("reports nothing for an explicit failure envelope", () => {
    expect(parseZaiQuota({ success: false, data: { limits: MEASURED.data.limits } }, NOW)).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "not json"],
    ["an empty object", {}],
    ["limits that is not an array", { data: { limits: { usage: 10 } } }],
    ["an empty limits array", { data: { limits: [] } }],
    ["entries that are not objects", { data: { limits: [1, "x", null] } }],
    ["entries with no readable fields", { data: { limits: [{ type: "CREDIT_LIMIT" }] } }],
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
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(MEASURED));
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await provider.refreshNow("seed", ROUTE)).toEqual({ routeId: ROUTE, outcome: "updated" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ZAI_QUOTA_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer zai-key");

    const snap = await provider.fetch(ROUTE);
    expect(snap?.serviceId).toBe("zai");
    expect(snap?.billingMode).toBe("sub");
    expect(snap?.routeId).toBe(ROUTE);
    expect(snap?.session?.usedPct).toBe(0.05);
    expect(snap?.weekly?.usedPct).toBe(7.9);
    expect(snap?.plan).toBe("Lite");
  });

  it("records no snapshot at all when the payload is unrecognised", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { limits: [{ tokens: 5 }] } }));
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provider.refreshNow("manual", ROUTE);
    expect(result.outcome).toBe("failed");
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

    expect((await provider.fetch(ROUTE))?.lockedUntil).toBe(NOW + 120_000);

    const second = await provider.refreshNow("manual", ROUTE);
    expect(second.outcome).toBe("locked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips a seed once a reading exists, but a manual press always attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(MEASURED));
    const provider = makeProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await provider.refreshNow("seed", ROUTE);
    expect(await provider.refreshNow("seed", ROUTE)).toEqual({ routeId: ROUTE, outcome: "skipped" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await provider.refreshNow("manual", ROUTE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent refreshes of the same route", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(MEASURED));
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
    release(jsonResponse(MEASURED));

    expect((await pending).outcome).toBe("skipped");
    expect(await provider.fetch(ROUTE)).toBeNull();
  });

  it("forgetRoute drops the reading, so a deleted credential loses its pill", async () => {
    const provider = makeProvider({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(MEASURED)) as unknown as typeof fetch,
    });
    await provider.refreshNow("seed", ROUTE);
    expect(await provider.fetch(ROUTE)).not.toBeNull();

    provider.forgetRoute(ROUTE);
    expect(await provider.fetch(ROUTE)).toBeNull();
  });

  it("keeps a harness-pushed reading, preferring whichever source is fresher", async () => {
    let clock = NOW;
    const provider = new ZaiLimitsProvider({
      listRouteIds: () => [ROUTE],
      secretForRoute: () => "zai-key",
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(MEASURED)) as unknown as typeof fetch,
      now: () => clock,
    });

    await provider.refreshNow("seed", ROUTE);
    expect((await provider.fetch(ROUTE))?.session?.usedPct).toBe(0.05);

    clock = NOW + 60_000;
    provider.setRateLimits(
      { usedPct: 61, resetAt: new Date(NOW + HOUR).toISOString() },
      null,
      ROUTE,
    );
    const snap = await provider.fetch(ROUTE);
    expect(snap?.session?.usedPct).toBe(61);
    expect(snap?.fetchedAt).toBe(NOW + 60_000);
    expect(snap?.plan).toBeNull();
  });
});
