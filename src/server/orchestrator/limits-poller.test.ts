import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LimitsPoller } from "./limits-poller.js";
import { LIMITS_SKIP_TICK } from "./limits/types.js";
import type { LimitsProvider, LimitsSkipTick } from "./limits/types.js";
import type { AgentId, SubscriptionLimits } from "../shared/types.js";

class StubLimitsProvider implements LimitsProvider {
  readonly agentId: AgentId;
  /** Sequence of snapshots to return on consecutive fetch() calls. */
  snapshots: (SubscriptionLimits | null | LimitsSkipTick)[] = [];
  fetchCallCount = 0;
  refreshFetchableCallCount = 0;
  fetchable = true;

  constructor(agentId: AgentId) {
    this.agentId = agentId;
  }

  canFetch(): boolean {
    return this.fetchable;
  }

  async refreshFetchable(): Promise<boolean> {
    this.refreshFetchableCallCount += 1;
    return this.fetchable;
  }

  async fetch(): Promise<SubscriptionLimits | null | LimitsSkipTick> {
    this.fetchCallCount += 1;
    const next = this.snapshots.shift();
    return next === undefined ? null : next;
  }

  enqueue(snapshot: SubscriptionLimits | null | LimitsSkipTick): this {
    this.snapshots.push(snapshot);
    return this;
  }
}

function makeSnapshot(overrides: Partial<SubscriptionLimits> & { agentId: AgentId }): SubscriptionLimits {
  return {
    plan: "Pro",
    session: { usedPct: 30, resetAt: "2026-05-19T18:00:00Z" },
    weekly: { usedPct: 40, resetAt: "2026-05-26T00:00:00Z" },
    weeklyOpus: null,
    fetchedAt: 1_000,
    ...overrides,
  };
}

interface BroadcastCall {
  event: string;
  data: unknown;
}

function makeBroadcastSpy(): { broadcast: (event: string, data: unknown) => void; calls: BroadcastCall[] } {
  const calls: BroadcastCall[] = [];
  return {
    broadcast: (event, data) => calls.push({ event, data }),
    calls,
  };
}

afterEach(() => vi.useRealTimers());

describe("LimitsPoller", () => {
  it("polls each fetchable provider on tick() and broadcasts a snapshot", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(makeSnapshot({ agentId: "claude" }));
    const codex = new StubLimitsProvider("codex").enqueue(makeSnapshot({ agentId: "codex", plan: "Plus" }));
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude], ["codex", codex]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick();

    expect(claude.fetchCallCount).toBe(1);
    expect(codex.fetchCallCount).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].event).toBe("subscription_limits");
    const payload = spy.calls[0].data as { limits: Record<string, SubscriptionLimits> };
    expect(payload.limits.claude.plan).toBe("Pro");
    expect(payload.limits.codex.plan).toBe("Plus");
  });

  it("omits unfetchable providers from the broadcast map", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(makeSnapshot({ agentId: "claude" }));
    const codex = new StubLimitsProvider("codex");
    codex.fetchable = false; // simulates "no Codex credentials"
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude], ["codex", codex]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick();

    const payload = spy.calls[0].data as { limits: Record<string, SubscriptionLimits | undefined> };
    expect(payload.limits.claude).toBeTruthy();
    expect(payload.limits.codex).toBeUndefined();
  });

  it("does not broadcast a duplicate when the snapshot is unchanged", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude" }))
      .enqueue(makeSnapshot({ agentId: "claude" })); // same numbers second tick
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick();
    await poller.tick();

    expect(claude.fetchCallCount).toBe(2);
    expect(spy.calls).toHaveLength(1);
  });

  it("broadcasts a delta when usedPct changes", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude", weekly: { usedPct: 40, resetAt: "x" } }))
      .enqueue(makeSnapshot({ agentId: "claude", weekly: { usedPct: 41, resetAt: "x" } }));
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick();
    await poller.tick();

    expect(spy.calls).toHaveLength(2);
  });

  it("halts polling on auth-expired error until markAuthRefreshed", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude", error: "auth expired", session: null, weekly: null, weeklyOpus: null }));
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick();
    expect(claude.fetchCallCount).toBe(1);

    // Second tick — auth-stalled — should NOT issue a fetch.
    await poller.tick();
    expect(claude.fetchCallCount).toBe(1);

    // After auth refresh, the next fetch fires immediately.
    claude.enqueue(makeSnapshot({ agentId: "claude" }));
    poller.markAuthRefreshed("claude");
    // markAuthRefreshed schedules an async refresh — flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));
    expect(claude.fetchCallCount).toBe(2);
  });

  it("triggerProviderRefresh fetches when the debounce window has elapsed", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude", fetchedAt: 1_000 }))
      .enqueue(makeSnapshot({ agentId: "claude", fetchedAt: 2_000, plan: "Max 20x" }));
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
      triggerDebounceMs: 20,
    });
    await poller.tick();
    expect(claude.fetchCallCount).toBe(1);

    // Wait past the debounce window and trigger — should fetch.
    await new Promise((resolve) => setTimeout(resolve, 40));
    poller.triggerProviderRefresh("claude");
    await new Promise((resolve) => setImmediate(resolve));
    expect(claude.fetchCallCount).toBe(2);
  });

  it("triggerProviderRefresh skips when called inside the debounce window", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude", fetchedAt: 1_000 }))
      .enqueue(makeSnapshot({ agentId: "claude", fetchedAt: 2_000 }));
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
      triggerDebounceMs: 90_000,
    });
    await poller.tick();
    expect(claude.fetchCallCount).toBe(1);

    // Burst of triggers inside the debounce window — only the first call's
    // attempt counted, the rest are no-ops. This is what prevents a tight
    // burst of turns from earning a 429 from /api/oauth/usage.
    poller.triggerProviderRefresh("claude");
    poller.triggerProviderRefresh("claude");
    poller.triggerProviderRefresh("claude");
    await new Promise((resolve) => setImmediate(resolve));
    expect(claude.fetchCallCount).toBe(1);
  });

  it("triggerProviderRefresh respects authStalled (does not defeat 401 halt)", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(
      makeSnapshot({
        agentId: "claude",
        error: "auth expired",
        session: null,
        weekly: null,
        weeklyOpus: null,
      }),
    );
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick();
    expect(claude.fetchCallCount).toBe(1);

    // Even after the debounce expires, an auth-stalled provider stays
    // halted until markAuthRefreshed — turn-driven refresh must not
    // bypass that.
    poller.triggerProviderRefresh("claude");
    await new Promise((resolve) => setImmediate(resolve));
    expect(claude.fetchCallCount).toBe(1);
  });

  it("triggerProviderRefresh respects 429 pollNotBefore backoff", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(
      makeSnapshot({
        agentId: "claude",
        error: "rate limited",
        session: null,
        weekly: null,
        weeklyOpus: null,
      }),
    );
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
      default429BackoffMs: 60_000,
      triggerDebounceMs: 10,
    });
    await poller.tick();
    expect(claude.fetchCallCount).toBe(1);

    // Wait past the debounce window — but the 429 backoff is much longer
    // (60s), so a turn-driven trigger must still be a no-op. Without this
    // guard a busy user could defeat the upstream backoff.
    await new Promise((resolve) => setTimeout(resolve, 30));
    poller.triggerProviderRefresh("claude");
    await new Promise((resolve) => setImmediate(resolve));
    expect(claude.fetchCallCount).toBe(1);
  });

  it("backs off after a transient error and clears on success", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude", error: "limits unavailable", session: null, weekly: null, weeklyOpus: null }));
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
      intervalMs: 1000,
      maxBackoffMs: 60_000,
    });
    await poller.tick();
    expect(claude.fetchCallCount).toBe(1);
    // Immediately after a transient failure, pollNotBefore is set in the future;
    // the next tick should skip.
    await poller.tick();
    expect(claude.fetchCallCount).toBe(1);
  });

  it("preserves prior data when a refresh errors after a successful fetch", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude", fetchedAt: 1_000 }))
      .enqueue(
        makeSnapshot({
          agentId: "claude",
          fetchedAt: 2_000,
          error: "rate limited",
          session: null,
          weekly: null,
          weeklyOpus: null,
        }),
      );
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
      intervalMs: 1000,
      default429BackoffMs: 60_000,
    });
    await poller.tick();
    await poller.tick();

    const last = spy.calls[spy.calls.length - 1].data as {
      limits: Record<string, SubscriptionLimits>;
    };
    // Data fields are preserved from the first successful fetch…
    expect(last.limits.claude.session?.usedPct).toBe(30);
    expect(last.limits.claude.weekly?.usedPct).toBe(40);
    // …fetchedAt stays pinned to when the data was fresh…
    expect(last.limits.claude.fetchedAt).toBe(1_000);
    // …and the fresh error reason rides along so the UI can surface it.
    expect(last.limits.claude.error).toBe("rate limited");
  });

  it("falls back to the error-only snapshot when no prior data exists", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(
      makeSnapshot({
        agentId: "claude",
        error: "limits unavailable",
        session: null,
        weekly: null,
        weeklyOpus: null,
      }),
    );
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick();

    const payload = spy.calls[0].data as { limits: Record<string, SubscriptionLimits> };
    expect(payload.limits.claude.error).toBe("limits unavailable");
    expect(payload.limits.claude.session).toBeNull();
    expect(payload.limits.claude.weekly).toBeNull();
  });

  it("clears the staleness when a later refresh succeeds", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude", fetchedAt: 1_000 }))
      .enqueue(
        makeSnapshot({
          agentId: "claude",
          fetchedAt: 2_000,
          error: "rate limited",
          session: null,
          weekly: null,
          weeklyOpus: null,
        }),
      )
      .enqueue(
        makeSnapshot({
          agentId: "claude",
          fetchedAt: 3_000,
          weekly: { usedPct: 55, resetAt: "z" },
        }),
      );
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
      intervalMs: 1000,
      default429BackoffMs: 0, // allow third tick to actually fetch
    });
    await poller.tick();
    await poller.tick();
    await poller.tick();

    const last = spy.calls[spy.calls.length - 1].data as {
      limits: Record<string, SubscriptionLimits>;
    };
    expect(last.limits.claude.error).toBeUndefined();
    expect(last.limits.claude.fetchedAt).toBe(3_000);
    expect(last.limits.claude.weekly?.usedPct).toBe(55);
  });

  it("keeps the last snapshot and does not broadcast when a provider skips a tick", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude", weekly: { usedPct: 40, resetAt: "x" } }))
      .enqueue(LIMITS_SKIP_TICK);
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick(); // success → cached + broadcast
    await poller.tick(); // skip → cache untouched, no new broadcast

    expect(claude.fetchCallCount).toBe(2);
    // Only the first tick broadcast; the skip produced no event.
    expect(spy.calls).toHaveLength(1);
    // The last good snapshot is still in the cache.
    expect(poller.getSnapshot().claude?.weekly?.usedPct).toBe(40);
    expect(poller.getSnapshot().claude?.error).toBeUndefined();
  });

  it("omits a provider that skips on a cold start (no prior snapshot)", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(LIMITS_SKIP_TICK);
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick();

    expect(claude.fetchCallCount).toBe(1);
    expect(spy.calls).toHaveLength(0);
    expect(poller.getSnapshot().claude).toBeUndefined();
  });

  it("markSignedOut drops a cached entry and broadcasts the removal", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(makeSnapshot({ agentId: "claude" }));
    const spy = makeBroadcastSpy();

    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });
    await poller.tick();
    expect(spy.calls).toHaveLength(1);

    poller.markSignedOut("claude");
    expect(poller.getSnapshot()).toEqual({});
    expect(spy.calls).toHaveLength(2);
    const last = spy.calls[1].data as { limits: Record<string, unknown> };
    expect(last.limits.claude).toBeUndefined();
  });

  it("getSnapshot() returns the empty object before any tick", () => {
    const claude = new StubLimitsProvider("claude");
    const spy = makeBroadcastSpy();
    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });
    expect(poller.getSnapshot()).toEqual({});
  });
});

describe("LimitsPoller (interval lifecycle)", () => {
  beforeEach(() => vi.useFakeTimers());

  it("start() runs an immediate tick and schedules the interval", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(makeSnapshot({ agentId: "claude" }));
    const spy = makeBroadcastSpy();
    const poller = new LimitsPoller({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
      intervalMs: 60_000,
    });
    poller.start();
    // Flush the immediate-tick microtask. runAllTicks is sync — calling
    // and awaiting Promise.resolve() is what actually flushes the
    // queued microtasks the poller fired.
    vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    poller.stop();
    expect(claude.fetchCallCount).toBeGreaterThanOrEqual(1);
  });
});
