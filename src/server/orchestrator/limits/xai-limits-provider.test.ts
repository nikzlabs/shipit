import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { XaiLimitsProvider, parseXaiBilling, XAI_QUOTA_URL } from "./xai-limits-provider.js";

const ROUTE = "acct_xai";
const NOW = Date.parse("2026-08-20T12:00:00Z");

// Captured from cli-chat-proxy.grok.com/v1/billing?format=credits on 2026-08-20.
const MEASURED = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-18T09:41:48.430622+00:00",
      end: "2026-08-25T09:41:48.430622+00:00",
    },
    creditUsagePercent: 10.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [
      { product: "GrokBuild", usagePercent: 10.0 },
      { product: "GrokChat" },
    ],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
    billingPeriodStart: "2026-08-18T09:41:48.430622+00:00",
    billingPeriodEnd: "2026-08-25T09:41:48.430622+00:00",
  },
};

// Bare /v1/billing also returns HTTP 200, but reports monthly spend.
const BARE_BILLING = {
  config: {
    monthlyLimit: { val: 0 },
    used: { val: 0 },
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_MONTHLY",
      start: "2026-08-01T00:00:00+00:00",
      end: "2026-09-01T00:00:00+00:00",
    },
  },
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

let tmpRoot: string;

function writeAuthFile(token: string | null): string {
  const root = fs.mkdtempSync(path.join(tmpRoot, "acct-"));
  fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".grok", "auth.json"),
    JSON.stringify(
      token === null
        ? { "https://auth.x.ai::7c9a": { refresh_token: "r" } }
        : { "https://auth.x.ai::7c9a": { key: token, refresh_token: "r" } },
    ),
  );
  return root;
}

function makeProvider(opts: {
  fetchImpl?: typeof fetch;
  credentialDir?: string | undefined;
  routes?: string[];
} = {}) {
  const credentialDir = "credentialDir" in opts ? opts.credentialDir : writeAuthFile("tok_live");
  return new XaiLimitsProvider({
    listRouteIds: () => opts.routes ?? [ROUTE],
    credentialDirForRoute: () => credentialDir,
    fetchImpl: opts.fetchImpl ?? (vi.fn() as unknown as typeof fetch),
    now: () => NOW,
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xai-limits-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("parseXaiBilling", () => {
  it("reads the weekly pool out of the measured payload", () => {
    const parsed = parseXaiBilling(MEASURED);
    expect(parsed).not.toBeNull();
    expect(parsed?.weekly.usedPct).toBe(10);
    expect(parsed?.weekly.resetAt).toBe("2026-08-25T09:41:48.430Z");
    expect(parsed?.weekly.startedAt).toBe("2026-08-18T09:41:48.430Z");
  });

  it("refuses the bare /v1/billing response rather than reading it as zero usage", () => {
    expect(parseXaiBilling(BARE_BILLING)).toBeNull();
  });

  it("refuses a period that is not weekly, which the pill would mislabel as 7d", () => {
    const monthly = {
      config: { ...MEASURED.config, currentPeriod: { ...MEASURED.config.currentPeriod, type: "USAGE_PERIOD_TYPE_MONTHLY" } },
    };
    expect(parseXaiBilling(monthly)).toBeNull();
  });

  it("does not fall back to the untyped billing-period fields", () => {
    const config: Record<string, unknown> = { ...MEASURED.config };
    delete config.currentPeriod;
    expect(parseXaiBilling({ config })).toBeNull();
  });

  it.each([-1, 101, Number.NaN])("refuses an out-of-range percentage (%s) rather than clamping it", (pct) => {
    expect(parseXaiBilling({ config: { ...MEASURED.config, creditUsagePercent: pct } })).toBeNull();
  });

  it("refuses a payload with no percentage at all", () => {
    const config: Record<string, unknown> = { ...MEASURED.config };
    delete config.creditUsagePercent;
    expect(parseXaiBilling({ config })).toBeNull();
  });

  it("refuses an unparseable reset time", () => {
    const broken = {
      config: { ...MEASURED.config, currentPeriod: { ...MEASURED.config.currentPeriod, end: "soon" } },
    };
    expect(parseXaiBilling(broken)).toBeNull();
  });

  it("keeps the window when only the start is unreadable, since the reset is what limits", () => {
    const noStart = {
      config: { ...MEASURED.config, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: MEASURED.config.currentPeriod.end } },
    };
    const parsed = parseXaiBilling(noStart);
    expect(parsed?.weekly.usedPct).toBe(10);
    expect(parsed?.weekly.startedAt).toBeUndefined();
  });

  it("tolerates an envelope one level flatter than the measured one", () => {
    expect(parseXaiBilling(MEASURED.config)?.weekly.usedPct).toBe(10);
  });

  it.each([null, undefined, 7, "credits", []])("refuses a non-object body (%s)", (body) => {
    expect(parseXaiBilling(body)).toBeNull();
  });
});

describe("XaiLimitsProvider", () => {
  it("reports the weekly window and NO short window", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MEASURED)) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });

    expect(await provider.refreshNow("manual", ROUTE)).toEqual({ routeId: ROUTE, outcome: "updated" });
    const snap = await provider.fetch(ROUTE);
    expect(snap?.weekly?.usedPct).toBe(10);
    expect(snap?.session).toBeNull();
    expect(snap?.availableWindows).toEqual(["weekly"]);
    expect(snap?.serviceId).toBe("xai");
    expect(snap?.billingMode).toBe("sub");
    expect(snap?.plan).toBeNull();
  });

  it("sends the account's own bearer token to the credits endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MEASURED)) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });
    await provider.refreshNow("manual", ROUTE);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(XAI_QUOTA_URL);
    expect(url).toContain("format=credits");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_live");
  });

  it("has nothing to report before the first read", async () => {
    expect(await makeProvider().fetch(ROUTE)).toBeNull();
  });

  it("says the account has no usable token rather than calling with none", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl, credentialDir: writeAuthFile(null) });
    expect(await provider.refreshNow("manual", ROUTE)).toMatchObject({ outcome: "no-credentials" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says the account is gone when it has no credential root", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl, credentialDir: undefined });
    expect(await provider.refreshNow("manual", ROUTE)).toMatchObject({ outcome: "no-credentials" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a rejected sign-in as an expired token", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });
    expect(await provider.refreshNow("manual", ROUTE)).toMatchObject({ outcome: "expired-token" });
  });

  it("reports a forbidden credential separately", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });
    expect(await provider.refreshNow("manual", ROUTE)).toMatchObject({ outcome: "no-credentials" });
  });

  it("locks out after a 429 and serves the countdown from a snapshot with no readings", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("", { status: 429, headers: { "retry-after": "120" } })) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });

    const first = await provider.refreshNow("manual", ROUTE);
    expect(first).toMatchObject({ outcome: "rate-limited", lockedUntil: NOW + 120_000 });
    const snap = await provider.fetch(ROUTE);
    expect(snap?.lockedUntil).toBe(NOW + 120_000);
    expect(snap?.weekly).toBeNull();
    expect(snap?.availableWindows).toBeUndefined();

    expect(await provider.refreshNow("manual", ROUTE)).toMatchObject({ outcome: "locked" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports an unreadable payload rather than a guessed number", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(BARE_BILLING)) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });
    expect(await provider.refreshNow("manual", ROUTE)).toMatchObject({ outcome: "failed" });
    expect(await provider.fetch(ROUTE)).toBeNull();
  });

  it("reports a network error as a failure the button can explain", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });
    expect(await provider.refreshNow("manual", ROUTE)).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("ECONNREFUSED") as unknown as string,
    });
  });

  it("seeds once per credential and skips a second seed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MEASURED)) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });
    expect(await provider.refreshNow("seed", ROUTE)).toMatchObject({ outcome: "updated" });
    expect(await provider.refreshNow("seed", ROUTE)).toMatchObject({ outcome: "skipped" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent refreshes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MEASURED)) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });
    await Promise.all([provider.refreshNow("manual", ROUTE), provider.refreshNow("manual", ROUTE)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("drops a route's reading when the credential goes away", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(MEASURED)) as unknown as typeof fetch;
    const provider = makeProvider({ fetchImpl });
    await provider.refreshNow("manual", ROUTE);
    provider.forgetRoute(ROUTE);
    expect(await provider.fetch(ROUTE)).toBeNull();
  });

  it("lists the routes it was given, without duplicates", () => {
    expect(makeProvider({ routes: [ROUTE, ROUTE, "acct_two"] }).routeIds()).toEqual([ROUTE, "acct_two"]);
  });
});
