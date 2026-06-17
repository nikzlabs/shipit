import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useEgressStore } from "./egress-store.js";
import type { EgressAllowlistEntry, EgressAllowlistView } from "../../server/shared/types.js";

/**
 * Stateful fetch stub backing the effective-allowlist view. GET returns the
 * current view; POST/DELETE/PUT mutate the in-memory user entries + toggle so
 * the store's post-mutation `refresh()` reconciles against real movement.
 */
function stubFetch(initial: { entries: EgressAllowlistEntry[]; globalEnabled?: boolean; override?: boolean | null }) {
  let entries = [...initial.entries];
  let globalEnabled = initial.globalEnabled ?? true;
  let override: boolean | null = initial.override ?? null;
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];

  const view = (): EgressAllowlistView => ({
    entries,
    globalEnabled,
    enforcementActive: true,
    session: {
      sessionId: "s1",
      override,
      hosts: [],
      effectiveContained: override ?? globalEnabled,
      globalEnabled,
      enforcementActive: true,
    },
    defaultsCustomized: false,
  });

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    if (url.startsWith("/api/egress/allowlist") && method === "GET") {
      return { ok: true, status: 200, json: async () => view() } as Response;
    }
    if (url === "/api/egress/settings" && method === "PUT") {
      globalEnabled = body?.globalEnabled as boolean;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if (url.startsWith("/api/egress/session/") && method === "PUT") {
      override = (body?.override ?? null) as boolean | null;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if (url === "/api/egress/hosts" && method === "POST") {
      const host = body?.host as string;
      const source = body?.scope === "global" ? "user-global" : "user-session";
      if (!entries.some((e) => e.host === host)) entries.push({ host, source, removable: true });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if (url === "/api/egress/hosts" && method === "DELETE") {
      entries = entries.filter((e) => e.host !== body?.host);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if (url === "/api/egress/defaults/restore" && method === "POST") {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    return { ok: false, status: 500, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return { calls };
}

const builtin = (host: string): EgressAllowlistEntry => ({ host, source: "builtin", removable: false });
const user = (host: string): EgressAllowlistEntry => ({ host, source: "user-global", removable: true });

describe("egress-store", () => {
  beforeEach(() => {
    useEgressStore.setState({ loaded: false, sessionId: null, entries: [], globalEnabled: true, override: null, effectiveContained: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("load() fetches the effective view and applies entries + toggle", async () => {
    stubFetch({ entries: [builtin(".github.com"), user("a.com")], globalEnabled: false });
    await useEgressStore.getState().load("s1");
    const s = useEgressStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.globalEnabled).toBe(false);
    expect(s.sessionId).toBe("s1");
    expect(s.entries.map((e) => e.host)).toEqual([".github.com", "a.com"]);
  });

  it("load() requests the session-scoped view when given a session", async () => {
    const { calls } = stubFetch({ entries: [] });
    await useEgressStore.getState().load("s1");
    expect(calls[0].url).toBe("/api/egress/allowlist?session=s1");
  });

  it("setGlobalEnabled() PUTs then reconciles via refresh, rolling back on failure", async () => {
    stubFetch({ entries: [], globalEnabled: true });
    await useEgressStore.getState().load(null);
    await useEgressStore.getState().setGlobalEnabled(false);
    expect(useEgressStore.getState().globalEnabled).toBe(false);
  });

  it("setGlobalEnabled() rolls back when the PUT fails", async () => {
    // Stub that fails the PUT.
    const impl = vi.fn(async (url: string) => {
      if (url.startsWith("/api/egress/allowlist")) {
        return { ok: true, status: 200, json: async () => ({ entries: [], globalEnabled: true, session: null, defaultsCustomized: false }) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", impl);
    await useEgressStore.getState().load(null);
    await expect(useEgressStore.getState().setGlobalEnabled(false)).rejects.toThrow();
    expect(useEgressStore.getState().globalEnabled).toBe(true);
  });

  it("addHost('global') optimistically shows the host then reconciles", async () => {
    const { calls } = stubFetch({ entries: [] });
    await useEgressStore.getState().load("s1");
    await useEgressStore.getState().addHost("api.example.com", "global");
    expect(useEgressStore.getState().entries.map((e) => e.host)).toContain("api.example.com");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ host: "api.example.com", scope: "global" });
  });

  it("addHost('session') posts the session id as the scope", async () => {
    const { calls } = stubFetch({ entries: [] });
    await useEgressStore.getState().load("s1");
    await useEgressStore.getState().addHost("api.example.com", "session");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ host: "api.example.com", scope: "s1" });
  });

  it("addHost ignores a blank host", async () => {
    const { calls } = stubFetch({ entries: [] });
    await useEgressStore.getState().load("s1");
    await useEgressStore.getState().addHost("  ", "global");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("removeHost() optimistically removes and DELETEs at the right scope", async () => {
    const { calls } = stubFetch({ entries: [user("a.com")] });
    await useEgressStore.getState().load("s1");
    await useEgressStore.getState().removeHost("a.com", "global");
    expect(useEgressStore.getState().entries.some((e) => e.host === "a.com")).toBe(false);
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ host: "a.com", scope: "global" });
  });

  it("editHost() removes the old host and adds the new one", async () => {
    const { calls } = stubFetch({ entries: [user("old.com")] });
    await useEgressStore.getState().load("s1");
    await useEgressStore.getState().editHost("old.com", "new.com", "global");
    const hosts = useEgressStore.getState().entries.map((e) => e.host);
    expect(hosts).toContain("new.com");
    expect(hosts).not.toContain("old.com");
    expect(calls.some((c) => c.method === "DELETE" && c.body?.host === "old.com")).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.body?.host === "new.com")).toBe(true);
  });

  it("restoreDefaults() POSTs the restore endpoint and refreshes", async () => {
    const { calls } = stubFetch({ entries: [] });
    await useEgressStore.getState().load(null);
    await useEgressStore.getState().restoreDefaults();
    expect(calls.some((c) => c.url === "/api/egress/defaults/restore" && c.method === "POST")).toBe(true);
  });

  it("setOverride() PUTs the session override and refreshes", async () => {
    const { calls } = stubFetch({ entries: [], globalEnabled: true });
    await useEgressStore.getState().load("s1");
    await useEgressStore.getState().setOverride(false);
    expect(useEgressStore.getState().override).toBe(false);
    expect(useEgressStore.getState().effectiveContained).toBe(false);
    expect(calls.find((c) => c.url.startsWith("/api/egress/session/"))?.body).toEqual({ override: false });
  });
});
