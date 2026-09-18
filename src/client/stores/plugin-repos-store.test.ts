

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  pluginsAttention,
  pluginsTabVisible,
  snapshotForSession,
  usePluginReposStore,
} from "./plugin-repos-store.js";
import { useSessionStore } from "./session-store.js";
import type { PluginReposSnapshot } from "../../server/shared/plugin-repos.js";
import type { EgressHostReach } from "../../server/shared/types.js";

const originalFetch = globalThis.fetch;

function snapshot(over: Partial<PluginReposSnapshot> = {}): PluginReposSnapshot {
  return { declared: true, pending: false, activating: false, consumerRepoUrl: null, repos: [], warnings: [], ...over };
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
    status: "active" as const,
    pinned: false,
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

  it("an unsatisfied plugin credential fires the dot (req 23)", () => {
    const use = (satisfied: boolean, optional = false) => ({
      plugin: "palette",
      alias: "artk",
      found: true,
      credentials: [{ name: "FAL_KEY", satisfied, optional }],
      hosts: [],
    });
    // A closed tab may hide information, never a gap the user must close.
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use(false)] }] }))).toBe(true);
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use(true)] }] }))).toBe(false);
    // reqs 23, 24 — an OPTIONAL key the project never set is not a gap the user
    // must close, so it must not light a dot that can then never be cleared.
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use(false, true)] }] }))).toBe(false);
  });

  it("a declared host the session may not reach fires the dot (req 24)", () => {
    const use = (reach: EgressHostReach, optional = false) => ({
      plugin: "palette",
      alias: "artk",
      found: true,
      credentials: [],
      hosts: [{ host: "fal.run", reach, optional }],
    });
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("grantable")] }] }))).toBe(true);
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("allowed")] }] }))).toBe(false);

    // user should be told about: the plugin cannot do its job either way.
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("blocked-by-deployment")] }] }))).toBe(true);
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("blocked-by-session")] }] }))).toBe(true);

    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("grantable", true)] }] }))).toBe(false);
    expect(
      pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("blocked-by-deployment", true)] }] })),
    ).toBe(false);
  });

  it("a snapshot from an older client build has neither list and must not throw", () => {

    const legacy = { plugin: "p", alias: "p", found: true } as unknown as (typeof card)["uses"][number];
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [legacy] }] }))).toBe(false);
  });
});

describe("allowHost", () => {
  beforeEach(() => {
    usePluginReposStore.setState({ snapshot: snapshot(), forSessionId: "sess-a" });
    useSessionStore.setState({ sessionId: "sess-a" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const captureFetch = (grantResponse: Response): ReturnType<typeof vi.fn> => {
    const impl = vi.fn(async (url: string) =>
      url === "/api/egress/hosts"
        ?                                                                        

          grantResponse.clone()
        : new Response(JSON.stringify(snapshot()), { status: 200 }),
    );
    globalThis.fetch = impl as unknown as typeof fetch;
    return impl;
  };

  it("scopes a session grant to the session id and a global one to `global`", async () => {
    const impl = captureFetch(new Response("{}", { status: 200 }));
    await usePluginReposStore.getState().allowHost("fal.run", "session");
    expect(JSON.parse(String(impl.mock.calls[0][1].body))).toEqual({ host: "fal.run", scope: "sess-a" });

    impl.mockClear();
    await usePluginReposStore.getState().allowHost("fal.run", "global");

    expect(JSON.parse(String(impl.mock.calls[0][1].body))).toEqual({
      host: "fal.run",
      scope: "global",
      session: "sess-a",
    });
  });

  it("resolves with what the add took effect on, and with null when told nothing", async () => {
    const grant = {
      host: "fal.run",
      scope: "global",
      liveNow: ["new-containers"],
      staleUntilRestart: ["agent", "services"],
      restartSessionId: "sess-a",
      reach: "grantable",
    };
    captureFetch(new Response(JSON.stringify({ grant }), { status: 200 }));
    expect(await usePluginReposStore.getState().allowHost("fal.run", "global")).toEqual(grant);

    captureFetch(new Response("{}", { status: 200 }));
    expect(await usePluginReposStore.getState().allowHost("fal.run", "global")).toBeNull();
  });

  it("refetches the snapshot afterwards, so the card stops naming a closed gap", async () => {
    const impl = captureFetch(new Response("{}", { status: 200 }));
    await usePluginReposStore.getState().allowHost("fal.run", "session");
    expect(impl.mock.calls.map((c) => c[0])).toEqual([
      "/api/egress/hosts",
      "/api/plugin-repos?sessionId=sess-a",
    ]);
  });

  it("refetches on failure too, and rethrows", async () => {

    // the card must be re-read rather than left asserting the old answer.
    const impl = captureFetch(new Response("{}", { status: 503 }));
    await expect(usePluginReposStore.getState().allowHost("fal.run", "session")).rejects.toThrow();
    expect(impl.mock.calls.map((c) => c[0])).toContain("/api/plugin-repos?sessionId=sess-a");
  });

  it("does nothing without a session or a host", async () => {
    const impl = captureFetch(new Response("{}", { status: 200 }));
    usePluginReposStore.setState({ forSessionId: null });
    await usePluginReposStore.getState().allowHost("fal.run", "session");
    usePluginReposStore.setState({ forSessionId: "sess-a" });
    await usePluginReposStore.getState().allowHost("   ", "global");
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("refreshRepo", () => {
  const REFRESH_URL = "/api/sessions/sess-a/plugin/refresh";

  beforeEach(() => {
    usePluginReposStore.setState({ snapshot: snapshot(), forSessionId: "sess-a" });
    useSessionStore.setState({ sessionId: "sess-a" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const captureFetch = (refreshResponse: Response): ReturnType<typeof vi.fn> => {
    const impl = vi.fn(async (url: string) =>
      url === REFRESH_URL
        ? refreshResponse.clone()
        : new Response(JSON.stringify(snapshot()), { status: 200 }),
    );
    globalThis.fetch = impl as unknown as typeof fetch;
    return impl;
  };

  const rowResponse = (row: Record<string, unknown>): Response =>
    new Response(JSON.stringify({ rows: [row] }), { status: 200 });

  it("posts the one named repository, never a blanket refresh", async () => {
    const impl = captureFetch(rowResponse({ repo: "tools", status: "unchanged", after: "abc" }));
    await usePluginReposStore.getState().refreshRepo("tools");
    expect(impl.mock.calls[0][0]).toBe(REFRESH_URL);
    expect(JSON.parse(String(impl.mock.calls[0][1].body))).toEqual({ repo: "tools" });
  });

  it("reports the three successful shapes apart", async () => {
    captureFetch(rowResponse({ status: "activated", before: "old", after: "new-commit" }));
    expect(await usePluginReposStore.getState().refreshRepo("tools")).toEqual({
      repo: "tools", kind: "activated", commit: "new-commit",
    });

    captureFetch(rowResponse({ status: "activated", reinstalled: true, after: "same" }));
    expect(await usePluginReposStore.getState().refreshRepo("tools")).toMatchObject({
      kind: "reinstalled", commit: "same",
    });

    captureFetch(rowResponse({ status: "unchanged", after: "same", detail: "tag moved" }));
    expect(await usePluginReposStore.getState().refreshRepo("tools")).toEqual({
      repo: "tools", kind: "unchanged", commit: "same", detail: "tag moved",
    });
  });

  it("carries the failure and the commit that is STILL live (req 15)", async () => {
    captureFetch(rowResponse({ status: "failed", after: "prior", detail: "fetch denied" }));
    expect(await usePluginReposStore.getState().refreshRepo("tools")).toEqual({
      repo: "tools", kind: "failed", commit: "prior", detail: "fetch denied",
    });
  });

  it("turns a refused request into a reported failure rather than a throw", async () => {

    captureFetch(new Response(JSON.stringify({ error: "`x` is not declared." }), { status: 400 }));
    expect(await usePluginReposStore.getState().refreshRepo("x")).toEqual({
      repo: "x", kind: "failed", commit: null, detail: "`x` is not declared.",
    });

    captureFetch(new Response("not json", { status: 500 }));
    expect(await usePluginReposStore.getState().refreshRepo("tools")).toMatchObject({
      kind: "failed", detail: "HTTP 500",
    });

    captureFetch(new Response(JSON.stringify({ rows: [] }), { status: 200 }));
    expect(await usePluginReposStore.getState().refreshRepo("tools")).toMatchObject({ kind: "failed" });
  });

  it("refetches the snapshot on success AND on failure", async () => {

    // issue row and the status becomes `degraded` — so the stale snapshot must

    for (const response of [
      rowResponse({ status: "activated", after: "new" }),
      new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
    ]) {
      const impl = captureFetch(response);
      await usePluginReposStore.getState().refreshRepo("tools");
      expect(impl.mock.calls.map((c) => c[0])).toEqual([
        REFRESH_URL,
        "/api/plugin-repos?sessionId=sess-a",
      ]);
    }
  });

  it("a refresh finishing after a session switch does not strand the new session", async () => {
    // The two must OVERLAP for this to reproduce: a B fetch that has already
    // landed cannot be invalidated retroactively. B's GET is therefore still in

    const gate = (): [Promise<void>, () => void] => {
      let open!: () => void;
      const held = new Promise<void>((resolve) => { open = resolve; });
      return [held, open];
    };
    const [refreshHeld, releaseRefresh] = gate();
    const [seedHeld, releaseSeed] = gate();
    const seeded = snapshot({ declared: true, warnings: ["session B"] });
    globalThis.fetch = (async (url: string) => {
      if (url === REFRESH_URL) {
        await refreshHeld;
        return new Response(JSON.stringify({ rows: [{ status: "unchanged", after: "x" }] }), { status: 200 });
      }
      if (url.endsWith("sessionId=sess-b")) {
        await seedHeld;
        return new Response(JSON.stringify(seeded), { status: 200 });
      }
      return new Response(JSON.stringify(snapshot()), { status: 200 });
    }) as unknown as typeof fetch;

    const refreshing = usePluginReposStore.getState().refreshRepo("tools");
    useSessionStore.setState({ sessionId: "sess-b" });
    usePluginReposStore.getState().reset();
    const seedingB = usePluginReposStore.getState().fetchSnapshot("sess-b");

    releaseRefresh();
    await refreshing;
    releaseSeed();
    await seedingB;

    expect(usePluginReposStore.getState().forSessionId).toBe("sess-b");
    expect(usePluginReposStore.getState().snapshot?.warnings).toEqual(["session B"]);
  });

  it("does nothing without a session", async () => {
    const impl = captureFetch(rowResponse({ status: "unchanged", after: "x" }));
    usePluginReposStore.setState({ forSessionId: null });
    expect(await usePluginReposStore.getState().refreshRepo("tools")).toMatchObject({ kind: "failed" });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("activating never leaves the card stuck", () => {
  beforeEach(() => {
    usePluginReposStore.setState({ snapshot: null, forSessionId: null });
    useSessionStore.setState({ sessionId: "sess-a" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("keeps polling while a repository is activating, then stops", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const impl = vi.fn(async () => {
        const activating = call++ < 2;
        return new Response(JSON.stringify(snapshot({ activating })), { status: 200 });
      });
      globalThis.fetch = impl as unknown as typeof fetch;

      await usePluginReposStore.getState().fetchSnapshot("sess-a");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(impl).toHaveBeenCalledTimes(3);
      expect(usePluginReposStore.getState().snapshot?.activating).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
