// docs/262 — the session-scoped store behind the Plugins tab.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  pluginsAttention,
  pluginsTabVisible,
  usePluginReposStore,
} from "./plugin-repos-store.js";
import { useSessionStore } from "./session-store.js";
import type { PluginReposSnapshot } from "../../server/shared/plugin-repos.js";

const originalFetch = globalThis.fetch;

function snapshot(over: Partial<PluginReposSnapshot> = {}): PluginReposSnapshot {
  return { declared: true, consumerRepoUrl: null, repos: [], warnings: [], ...over };
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
