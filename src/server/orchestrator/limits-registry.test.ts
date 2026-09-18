import { describe, it, expect } from "vitest";
import { LimitsRegistry } from "./limits-registry.js";
import type { LimitsProvider } from "./agents/types.js";
import type { SubscriptionLimits } from "../shared/types.js";

const STUB_ROUTE = "acct-stub";

const ANTHROPIC = "anthropic:sub";
const OPENAI = "openai:sub";

class StubLimitsProvider implements LimitsProvider {
  readonly serviceId: string;
  readonly billingMode = "sub" as const;
  snapshots: (SubscriptionLimits | null)[] = [];
  fetchCallCount = 0;

  constructor(serviceId: string) {
    this.serviceId = serviceId;
  }

  routeIds(): string[] {
    return [...this.liveRoutes];
  }
  liveRoutes = new Set<string>([STUB_ROUTE]);

  byRoute = new Map<string, SubscriptionLimits | null>();

  async fetch(routeId: string): Promise<SubscriptionLimits | null> {
    this.fetchCallCount += 1;
    if (this.byRoute.has(routeId)) return this.byRoute.get(routeId) ?? null;
    const next = this.snapshots.shift();
    return next === undefined ? null : next;
  }

  forgetRoute(routeId: string): void {
    this.liveRoutes.delete(routeId);
  }

  enqueue(snapshot: SubscriptionLimits | null): this {
    this.snapshots.push(snapshot);
    return this;
  }

  setRateLimits(): void {
    /* unused in registry-level tests */
  }
}

function makeSnapshot(
  overrides: Partial<SubscriptionLimits> = {},
): SubscriptionLimits {
  return {
    serviceId: "anthropic",
    billingMode: "sub",
    routeId: STUB_ROUTE,
    plan: "Pro",
    session: { usedPct: 30, resetAt: "2026-05-19T18:00:00Z" },
    weekly: { usedPct: 40, resetAt: "2026-05-26T00:00:00Z" },
    fetchedAt: 1_000,
    ...overrides,
  };
}

interface BroadcastCall {
  event: string;
  data: unknown;
}

function makeBroadcastSpy(): {
  broadcast: (event: string, data: unknown) => void;
  calls: BroadcastCall[];
} {
  const calls: BroadcastCall[] = [];
  return {
    broadcast: (event, data) => calls.push({ event, data }),
    calls,
  };
}

describe("LimitsRegistry", () => {
  it("markAuthRefreshed pulls the latest snapshot and broadcasts", async () => {
    const claude = new StubLimitsProvider("anthropic").enqueue(
      makeSnapshot({ plan: "Max 20x" }),
    );
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<string, LimitsProvider>([[ANTHROPIC, claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));

    expect(claude.fetchCallCount).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].event).toBe("subscription_limits");
    const payload = spy.calls[0].data as { limits: Record<string, Record<string, SubscriptionLimits>> };
    expect(payload.limits[ANTHROPIC][STUB_ROUTE].plan).toBe("Max 20x");
  });

  it("does not rebroadcast when the snapshot is unchanged", async () => {
    const snap = makeSnapshot();
    const claude = new StubLimitsProvider("anthropic").enqueue(snap).enqueue(snap);
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<string, LimitsProvider>([[ANTHROPIC, claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));
    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));

    expect(claude.fetchCallCount).toBe(2);
    expect(spy.calls).toHaveLength(1);
  });

  it("rebroadcasts when usedPct transitions from null to a number", async () => {
    const claude = new StubLimitsProvider("anthropic")
      .enqueue(
        makeSnapshot({
                    session: { usedPct: null, resetAt: "2026-05-19T18:00:00Z" },
        }),
      )
      .enqueue(
        makeSnapshot({
                    session: { usedPct: 42, resetAt: "2026-05-19T18:00:00Z" },
        }),
      );
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<string, LimitsProvider>([[ANTHROPIC, claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));
    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));

    expect(spy.calls).toHaveLength(2);
    const first = spy.calls[0].data as { limits: Record<string, Record<string, SubscriptionLimits>> };
    const second = spy.calls[1].data as { limits: Record<string, Record<string, SubscriptionLimits>> };
    expect(first.limits[ANTHROPIC][STUB_ROUTE].session?.usedPct).toBeNull();
    expect(second.limits[ANTHROPIC][STUB_ROUTE].session?.usedPct).toBe(42);
  });

  it("rebroadcasts when a window's usedPct changes", async () => {
    const claude = new StubLimitsProvider("anthropic")
      .enqueue(makeSnapshot())
      .enqueue(
        makeSnapshot({
                    session: { usedPct: 65, resetAt: "2026-05-19T18:00:00Z" },
        }),
      );
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<string, LimitsProvider>([[ANTHROPIC, claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));
    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));

    expect(spy.calls).toHaveLength(2);
    const second = spy.calls[1].data as { limits: Record<string, Record<string, SubscriptionLimits>> };
    expect(second.limits[ANTHROPIC][STUB_ROUTE].session?.usedPct).toBe(65);
  });

  it("getSnapshot returns the cached map and omits unfetchable providers", async () => {
    const claude = new StubLimitsProvider("anthropic").enqueue(makeSnapshot());
    const codex = new StubLimitsProvider("openai");
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<string, LimitsProvider>([[ANTHROPIC, claude], [OPENAI, codex]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed(ANTHROPIC);
    registry.markAuthRefreshed(OPENAI);
    await new Promise((resolve) => setImmediate(resolve));

    const snap = registry.getSnapshot();
    expect(snap[ANTHROPIC]).toBeTruthy();
    expect(snap[OPENAI]).toBeUndefined();
  });

  it("markSignedOut drops the cached entry and broadcasts", async () => {
    const claude = new StubLimitsProvider("anthropic").enqueue(makeSnapshot());
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<string, LimitsProvider>([[ANTHROPIC, claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.getSnapshot()[ANTHROPIC]).toBeTruthy();

    registry.markSignedOut(ANTHROPIC);
    expect(registry.getSnapshot()[ANTHROPIC]).toBeUndefined();
    expect(spy.calls).toHaveLength(2);
    expect(
      (spy.calls[1].data as { limits: Record<string, unknown> }).limits[ANTHROPIC],
    ).toBeUndefined();
  });

  it("markSignedOut is a no-op (no broadcast) when the entry was already absent", () => {
    const claude = new StubLimitsProvider("anthropic");
    const spy = makeBroadcastSpy();
    const registry = new LimitsRegistry({
      providers: new Map<string, LimitsProvider>([[ANTHROPIC, claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markSignedOut(ANTHROPIC);
    expect(spy.calls).toHaveLength(0);
  });

  it("keeps two accounts of one provider independent (docs/150-multiple-provider-subscriptions req 10)", async () => {
    const provider = new StubLimitsProvider("anthropic");
    provider.liveRoutes = new Set(["acct-a", "acct-b"]);
    provider.byRoute.set("acct-a", makeSnapshot({ routeId: "acct-a", session: { usedPct: 90, resetAt: "2026-05-19T18:00:00Z" } }));
    provider.byRoute.set("acct-b", makeSnapshot({ routeId: "acct-b", session: { usedPct: 10, resetAt: "2026-05-19T20:00:00Z" } }));
    const spy = makeBroadcastSpy();
    const registry = new LimitsRegistry({
      providers: new Map([[ANTHROPIC, provider]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));

    const snap = registry.getSnapshot();
    expect(snap[ANTHROPIC]?.["acct-a"]?.session?.usedPct).toBe(90);
    expect(snap[ANTHROPIC]?.["acct-b"]?.session?.usedPct).toBe(10);
  });

  it("refreshes only the named route, and fans out only without one", async () => {
    const provider = new StubLimitsProvider("anthropic");
    provider.liveRoutes = new Set(["acct-a", "acct-b"]);
    provider.byRoute.set("acct-a", makeSnapshot({ routeId: "acct-a" }));
    provider.byRoute.set("acct-b", makeSnapshot({ routeId: "acct-b" }));
    const refreshed: string[] = [];
    (provider as LimitsProvider).refreshNow = async (_reason, routeId) => {
      refreshed.push(routeId);
      return { routeId, outcome: "updated" as const };
    };
    const registry = new LimitsRegistry({
      providers: new Map([[ANTHROPIC, provider]]),
      sseBroadcast: makeBroadcastSpy().broadcast,
    });

    const scoped = await registry.refreshNow(ANTHROPIC, "manual", "acct-a");
    expect(refreshed).toEqual(["acct-a"]);
    expect(scoped).toEqual([{ routeId: "acct-a", outcome: "updated" }]);

    refreshed.length = 0;
    await registry.refreshNow(ANTHROPIC, "seed");
    expect(refreshed.sort()).toEqual(["acct-a", "acct-b"]);
  });

  it("reports a route whose provider has no on-demand refresh", async () => {
    const registry = new LimitsRegistry({
      providers: new Map([[OPENAI, new StubLimitsProvider("openai")]]),
      sseBroadcast: makeBroadcastSpy().broadcast,
    });
    expect(await registry.refreshNow(OPENAI, "manual", "acct-x")).toEqual([
      { routeId: "acct-x", outcome: "unavailable" },
    ]);
  });

  it("drops only the disconnected account's pill", async () => {
    const provider = new StubLimitsProvider("anthropic");
    provider.liveRoutes = new Set(["acct-a", "acct-b"]);
    provider.byRoute.set("acct-a", makeSnapshot({ routeId: "acct-a" }));
    provider.byRoute.set("acct-b", makeSnapshot({ routeId: "acct-b" }));
    const spy = makeBroadcastSpy();
    const registry = new LimitsRegistry({
      providers: new Map([[ANTHROPIC, provider]]),
      sseBroadcast: spy.broadcast,
    });
    registry.markAuthRefreshed(ANTHROPIC);
    await new Promise((resolve) => setImmediate(resolve));

    registry.markSignedOut(ANTHROPIC, "acct-a");

    const snap = registry.getSnapshot();
    expect(snap[ANTHROPIC]?.["acct-a"]).toBeUndefined();
    expect(snap[ANTHROPIC]?.["acct-b"]).toBeDefined();
    expect(provider.routeIds()).toEqual(["acct-b"]);
  });
});
