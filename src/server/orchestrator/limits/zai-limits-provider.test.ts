import { describe, it, expect, vi } from "vitest";
import { ZaiLimitsProvider, parseZaiQuota, ZAI_QUOTA_URL } from "./zai-limits-provider.js";

const ROUTE = "cred_glm";
const NOW = Date.parse("2026-08-17T17:30:00Z");
const HOUR = 60 * 60_000;

/**
 * **The measured payload**, captured verbatim from `api.z.ai` against a real
 * coding-plan key on 2026-08-17, after one small request had opened the 5-hour
 * window. Everything else in this file is a variation on it.
 *
 * It is transcribed rather than paraphrased because every plausible reading of
 * these field names is wrong in some way (see the module docstring), so a
 * fixture that "looks about right" would re-admit exactly the bugs the shape
 * caused. `usage` is the ALLOWANCE, `remaining` is what is left, `currentValue`
 * lags both, and `percentage` reports 1 for a true 0.05%.
 */
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
        // (2000 - 1999) / 2000 — the EXACT fraction, not the payload's coarse
        // `percentage: 1`.
        usedPct: 0.05,
        resetAt: new Date(NOW + 5 * HOUR).toISOString(),
        // `unit: 3, number: 5` is a measured five hours, so the window's start
        // is known rather than assumed from the badge's constant.
        startedAt: new Date(NOW).toISOString(),
      },
      weekly: {
        usedPct: 7.9,
        resetAt: new Date(NOW + 116 * HOUR).toISOString(),
        // `unit: 6, number: 1` is one week, so this window's start is known
        // too. Its provenance differs from the 5h window's — see `UNIT_MS`.
        startedAt: new Date(NOW + 116 * HOUR - 7 * 24 * HOUR).toISOString(),
      },
      plan: "Lite",
    });
  });

  it("treats `usage` as the allowance, never as a percentage", () => {
    // THE regression this file exists for. An earlier parser took `usage` from
    // community field names and read 2000 as a percent — which, clamped, would
    // have painted a full bar over a plan at 0.05%. Rejecting out-of-range
    // values is what caught it, and deriving from `remaining` is the fix.
    const parsed = parseZaiQuota(MEASURED, NOW);
    expect(parsed?.session?.usedPct).toBe(0.05);
    expect(parsed?.session?.usedPct).not.toBe(100);
  });

  it("ignores `currentValue`, which lags `remaining` inside one entry", () => {
    // Measured: after one request `remaining` moved 2000 → 1999 while
    // `currentValue` stayed 0. Reading it would report the window as untouched.
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
    // Measured shape before any usage: full `remaining`, and NO `nextResetTime`
    // at all. That is "no window is open", and a countdown cannot be drawn for
    // it — but it must not take the whole payload down with it.
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
    // The fallback exists so an unknown unit degrades to something less precise
    // rather than to a confident `startedAt` drawn from an invented length.
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
    // The horizon rule alone would call a monthly window resetting in 2h a "5h
    // window". The declared length is the API's own statement, so it wins.
    const parsed = parseZaiQuota(
      { data: { limits: [{ unit: 3, number: 168, usage: 100, remaining: 40, nextResetTime: NOW + 2 * HOUR }] } },
      NOW,
    );
    expect(parsed?.session).toBeNull();
    expect(parsed?.weekly?.usedPct).toBe(60);
  });

  // ---- Fail-closed rules. Each of these would otherwise render a number
  // ---- nobody measured, which req 10 prefers an empty pill to.

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
    // Ambiguous: nothing distinguishes which of these is the 5h window, and
    // picking one is a coin flip presented as a measurement.
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
    // The tier rides the same response as the numbers, unlike Claude's (a
    // credentials file) and Codex's (a JWT claim).
    expect(snap?.plan).toBe("Lite");
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
    // Nothing is known to push one for a GLM credential, but a reading that
    // does arrive is real, and dropping it would be a lie of omission.
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
    // An event carries no tier, so the pill loses its label rather than keeping
    // one that describes an older reading.
    expect(snap?.plan).toBeNull();
  });
});
