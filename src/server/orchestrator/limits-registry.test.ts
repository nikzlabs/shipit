import { describe, it, expect } from "vitest";
import { LimitsRegistry } from "./limits-registry.js";
import type { LimitsProvider } from "./limits/types.js";
import type { AgentId, SubscriptionLimits } from "../shared/types.js";

class StubLimitsProvider implements LimitsProvider {
  readonly agentId: AgentId;
  /** Sequence of snapshots returned by consecutive `fetch()` calls. */
  snapshots: (SubscriptionLimits | null)[] = [];
  fetchCallCount = 0;

  constructor(agentId: AgentId) {
    this.agentId = agentId;
  }

  canFetch(): boolean {
    return this.snapshots.length > 0;
  }

  async fetch(): Promise<SubscriptionLimits | null> {
    this.fetchCallCount += 1;
    const next = this.snapshots.shift();
    return next === undefined ? null : next;
  }

  enqueue(snapshot: SubscriptionLimits | null): this {
    this.snapshots.push(snapshot);
    return this;
  }

  // `setRateLimits` is part of the LimitsProvider interface (docs/155), but
  // these registry tests drive the snapshot through `fetch()` directly. The
  // no-op is enough to satisfy the type contract.
  setRateLimits(): void {
    /* unused in registry-level tests */
  }
}

function makeSnapshot(
  overrides: Partial<SubscriptionLimits> & { agentId: AgentId },
): SubscriptionLimits {
  return {
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
    const claude = new StubLimitsProvider("claude").enqueue(
      makeSnapshot({ agentId: "claude", plan: "Max 20x" }),
    );
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed("claude");
    await new Promise((resolve) => setImmediate(resolve));

    expect(claude.fetchCallCount).toBe(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].event).toBe("subscription_limits");
    const payload = spy.calls[0].data as { limits: Record<string, SubscriptionLimits> };
    expect(payload.limits.claude.plan).toBe("Max 20x");
  });

  it("does not rebroadcast when the snapshot is unchanged", async () => {
    const snap = makeSnapshot({ agentId: "claude" });
    const claude = new StubLimitsProvider("claude").enqueue(snap).enqueue(snap);
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed("claude");
    await new Promise((resolve) => setImmediate(resolve));
    registry.markAuthRefreshed("claude");
    await new Promise((resolve) => setImmediate(resolve));

    expect(claude.fetchCallCount).toBe(2);
    // Snapshot fields are identical → no extra SSE event.
    expect(spy.calls).toHaveLength(1);
  });

  it("rebroadcasts when usedPct transitions from null to a number", async () => {
    // Claude CLI 2.1.140 first reports the window without `utilization`
    // (anthropics/claude-code#50518) and only fills it in once a warning
    // threshold trips. The registry must broadcast on each side of that
    // transition so the badge upgrades from countdown-only to a full meter.
    const claude = new StubLimitsProvider("claude")
      .enqueue(
        makeSnapshot({
          agentId: "claude",
          session: { usedPct: null, resetAt: "2026-05-19T18:00:00Z" },
        }),
      )
      .enqueue(
        makeSnapshot({
          agentId: "claude",
          session: { usedPct: 42, resetAt: "2026-05-19T18:00:00Z" },
        }),
      );
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed("claude");
    await new Promise((resolve) => setImmediate(resolve));
    registry.markAuthRefreshed("claude");
    await new Promise((resolve) => setImmediate(resolve));

    expect(spy.calls).toHaveLength(2);
    const first = spy.calls[0].data as { limits: Record<string, SubscriptionLimits> };
    const second = spy.calls[1].data as { limits: Record<string, SubscriptionLimits> };
    expect(first.limits.claude.session?.usedPct).toBeNull();
    expect(second.limits.claude.session?.usedPct).toBe(42);
  });

  it("rebroadcasts when a window's usedPct changes", async () => {
    const claude = new StubLimitsProvider("claude")
      .enqueue(makeSnapshot({ agentId: "claude" }))
      .enqueue(
        makeSnapshot({
          agentId: "claude",
          session: { usedPct: 65, resetAt: "2026-05-19T18:00:00Z" },
        }),
      );
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed("claude");
    await new Promise((resolve) => setImmediate(resolve));
    registry.markAuthRefreshed("claude");
    await new Promise((resolve) => setImmediate(resolve));

    expect(spy.calls).toHaveLength(2);
    const second = spy.calls[1].data as { limits: Record<string, SubscriptionLimits> };
    expect(second.limits.claude.session?.usedPct).toBe(65);
  });

  it("getSnapshot returns the cached map and omits unfetchable providers", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(makeSnapshot({ agentId: "claude" }));
    const codex = new StubLimitsProvider("codex"); // never received an event
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude], ["codex", codex]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed("claude");
    registry.markAuthRefreshed("codex");
    await new Promise((resolve) => setImmediate(resolve));

    const snap = registry.getSnapshot();
    expect(snap.claude).toBeTruthy();
    expect(snap.codex).toBeUndefined();
  });

  it("markSignedOut drops the cached entry and broadcasts", async () => {
    const claude = new StubLimitsProvider("claude").enqueue(makeSnapshot({ agentId: "claude" }));
    const spy = makeBroadcastSpy();

    const registry = new LimitsRegistry({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markAuthRefreshed("claude");
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.getSnapshot().claude).toBeTruthy();

    registry.markSignedOut("claude");
    expect(registry.getSnapshot().claude).toBeUndefined();
    // Second broadcast carries the empty map so the client drops the pill.
    expect(spy.calls).toHaveLength(2);
    expect(
      (spy.calls[1].data as { limits: Record<string, unknown> }).limits.claude,
    ).toBeUndefined();
  });

  it("markSignedOut is a no-op (no broadcast) when the entry was already absent", () => {
    const claude = new StubLimitsProvider("claude");
    const spy = makeBroadcastSpy();
    const registry = new LimitsRegistry({
      providers: new Map<AgentId, LimitsProvider>([["claude", claude]]),
      sseBroadcast: spy.broadcast,
    });

    registry.markSignedOut("claude");
    expect(spy.calls).toHaveLength(0);
  });
});
