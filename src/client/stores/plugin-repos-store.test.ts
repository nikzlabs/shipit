// docs/262 — the session-scoped store behind the Plugins tab.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  pluginsAttention,
  pluginsTabVisible,
  snapshotForSession,
  usePluginReposStore,
} from "./plugin-repos-store.js";
import { useSessionStore } from "./session-store.js";
import type { PluginReposSnapshot } from "../../server/shared/plugin-repos.js";

const originalFetch = globalThis.fetch;

function snapshot(over: Partial<PluginReposSnapshot> = {}): PluginReposSnapshot {
  return { declared: true, pending: false, consumerRepoUrl: null, repos: [], warnings: [], ...over };
}

function stubFetch(body: PluginReposSnapshot, status = 200): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  globalThis.fetch = impl as unknown as typeof fetch;
  return impl;
}

describe("plugin-repos store", () => {
  beforeEach(() => {
    usePluginReposStore.setState({ snapshot: null, forSessionId: null });
    useSessionStore.setState({ sessionId: "sess-a" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("stores the snapshot for the session it was fetched for", async () => {
    const fetchMock = stubFetch(snapshot({ declared: true }));
    await usePluginReposStore.getState().fetchSnapshot("sess-a");
    expect(fetchMock).toHaveBeenCalledWith("/api/plugin-repos?sessionId=sess-a");
    expect(usePluginReposStore.getState().snapshot?.declared).toBe(true);
    expect(usePluginReposStore.getState().forSessionId).toBe("sess-a");
  });

  it("drops a response that lands after a session switch (stale guard)", async () => {
    stubFetch(snapshot());
    const fetching = usePluginReposStore.getState().fetchSnapshot("sess-a");
    useSessionStore.setState({ sessionId: "sess-b" });
    await fetching;
    expect(usePluginReposStore.getState().snapshot).toBeNull();
  });

  it("a failed response leaves the store untouched", async () => {
    stubFetch(snapshot(), 500);
    await usePluginReposStore.getState().fetchSnapshot("sess-a");
    expect(usePluginReposStore.getState().snapshot).toBeNull();
  });

  // Latest-wins: the seeding fetch and a files-changed refetch overlap freely,
  // so response order must not decide which declaration the tab gates on.
  it("an older same-session response cannot overwrite a newer one", async () => {
    const bodies = [
      snapshot({ warnings: ["stale"] }),
      snapshot({ warnings: ["fresh"] }),
    ];
    let call = 0;
    const resolvers: (() => void)[] = [];
    globalThis.fetch = (async () => {
      const body = bodies[call++];
      // Hold both responses open, then release them in reverse order.
      await new Promise<void>((r) => resolvers.push(r));
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const first = usePluginReposStore.getState().fetchSnapshot("sess-a");
    const second = usePluginReposStore.getState().fetchSnapshot("sess-a");
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]();
    await second;
    resolvers[0]();
    await first;

    expect(usePluginReposStore.getState().snapshot?.warnings).toEqual(["fresh"]);
  });

  it("reset invalidates an in-flight fetch", async () => {
    let release!: () => void;
    globalThis.fetch = (async () => {
      await new Promise<void>((r) => (release = r));
      return new Response(JSON.stringify(snapshot()), { status: 200 });
    }) as unknown as typeof fetch;

    const fetching = usePluginReposStore.getState().fetchSnapshot("sess-a");
    await vi.waitFor(() => expect(release).toBeDefined());
    usePluginReposStore.getState().reset();
    release();
    await fetching;
    expect(usePluginReposStore.getState().snapshot).toBeNull();
  });

  it("retries while the checkout can't answer, then stops", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const impl = vi.fn(async () => {
        const pending = call++ < 2;
        return new Response(JSON.stringify(snapshot({ pending })), { status: 200 });
      });
      globalThis.fetch = impl as unknown as typeof fetch;

      await usePluginReposStore.getState().fetchSnapshot("sess-a");
      expect(impl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      // Two pending answers, then a real one — and no further polling.
      expect(impl).toHaveBeenCalledTimes(3);
      expect(usePluginReposStore.getState().snapshot?.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("snapshotForSession", () => {
  const snap = snapshot();

  it("returns the snapshot only for its owning session", () => {
    const state = { snapshot: snap, forSessionId: "sess-a" } as never;
    expect(snapshotForSession(state, "sess-a")).toBe(snap);
    // The regression this guards: a switch that skipped the reset would leave
    // the previous session's tab, dot and cards on screen.
    expect(snapshotForSession(state, "sess-b")).toBeNull();
    expect(snapshotForSession(state, null)).toBeNull();
  });
});

describe("tab gating and attention (plan §3)", () => {
  const card = {
    name: "tools",
    source: "a/b",
    ref: "main",
    commit: null,
    status: "declared" as const,
    uses: [],
    issues: [] as string[],
  };

  it("no snapshot → no tab", () => {
    expect(pluginsTabVisible(null)).toBe(false);
  });

  it("intent shows the tab even with zero valid repos (req 13)", () => {
    expect(pluginsTabVisible(snapshot({ declared: true, repos: [] }))).toBe(true);
  });

  it("no intent and no warnings → no tab", () => {
    expect(pluginsTabVisible(snapshot({ declared: false }))).toBe(false);
  });

  it("warnings alone show the tab — an unreadable declaration keeps its surface", () => {
    expect(
      pluginsTabVisible(snapshot({ declared: false, warnings: ["shipit.yaml could not be parsed"] })),
    ).toBe(true);
  });

  it("the dot fires on warnings and per-repo issues, not on the v0 declared state", () => {
    expect(pluginsAttention(snapshot({ repos: [card] }))).toBe(false);
    expect(pluginsAttention(snapshot({ warnings: ["w"] }))).toBe(true);
    expect(pluginsAttention(snapshot({ repos: [{ ...card, issues: ["missing"] }] }))).toBe(true);
  });
});
