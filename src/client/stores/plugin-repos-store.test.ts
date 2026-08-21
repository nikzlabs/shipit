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
    status: "active" as const,
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
    const use = (satisfied: boolean) => ({
      plugin: "palette",
      alias: "artk",
      found: true,
      credentials: [{ name: "FAL_KEY", satisfied }],
      hosts: [],
    });
    // A closed tab may hide information, never a gap the user must close.
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use(false)] }] }))).toBe(true);
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use(true)] }] }))).toBe(false);
  });

  it("a declared host the session may not reach fires the dot (req 24)", () => {
    const use = (reach: EgressHostReach) => ({
      plugin: "palette",
      alias: "artk",
      found: true,
      credentials: [],
      hosts: [{ host: "fal.run", reach }],
    });
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("grantable")] }] }))).toBe(true);
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("allowed")] }] }))).toBe(false);
    // planning#383 — a gap nobody the user can be will close is still a gap the
    // user should be told about: the plugin cannot do its job either way.
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("blocked-by-deployment")] }] }))).toBe(true);
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [use("blocked-by-session")] }] }))).toBe(true);
  });

  it("a snapshot from an older client build has neither list and must not throw", () => {
    // The store outlives a deploy: a cached response predating `hosts` (or
    // `credentials`) reaches this predicate as `undefined`.
    const legacy = { plugin: "p", alias: "p", found: true } as unknown as (typeof card)["uses"][number];
    expect(pluginsAttention(snapshot({ repos: [{ ...card, uses: [legacy] }] }))).toBe(false);
  });
});

// req 24's affordance: the grant is the USER's act on the USER's allowlist —
// the existing browser-only egress route, at one of the two scopes the
// requirement names. Nothing plugin-shaped, and nothing a declaration triggers.
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
        ? // Cloned per call: one grant response is reused across the two scopes,
          // and a body can only be read once.
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
    // planning#376 — the session rides along for REPORTING only. The entry
    // still lands at instance scope; the id says whose surfaces the route
    // should report on, since a global add reaches them very differently.
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
    // `POST /api/egress/hosts` answers 503 for "saved, but the live refresh
    // failed closed" — the host may be allowed even though the call failed, so
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
