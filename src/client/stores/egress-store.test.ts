import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useEgressStore } from "./egress-store.js";
import type { EgressSettings } from "../../server/shared/types.js";

/** Build a fetch stub that returns the given snapshot for every JSON response. */
function stubFetch(snapshot: EgressSettings, ok = true) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => snapshot,
    } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return { calls };
}

describe("egress-store", () => {
  beforeEach(() => {
    useEgressStore.setState({ loaded: false, globalEnabled: true, globalHosts: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("load() fetches and applies the snapshot", async () => {
    stubFetch({ globalEnabled: false, globalHosts: ["a.com"] });
    await useEgressStore.getState().load();
    const s = useEgressStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.globalEnabled).toBe(false);
    expect(s.globalHosts).toEqual(["a.com"]);
  });

  it("setGlobalEnabled() optimistically updates and PUTs", async () => {
    const { calls } = stubFetch({ globalEnabled: false, globalHosts: [] });
    await useEgressStore.getState().setGlobalEnabled(false);
    expect(useEgressStore.getState().globalEnabled).toBe(false);
    expect(calls.at(-1)).toMatchObject({ url: "/api/egress/settings", method: "PUT", body: { globalEnabled: false } });
  });

  it("setGlobalEnabled() rolls back on failure", async () => {
    stubFetch({ globalEnabled: false, globalHosts: [] }, false);
    await expect(useEgressStore.getState().setGlobalEnabled(false)).rejects.toThrow();
    expect(useEgressStore.getState().globalEnabled).toBe(true); // reverted
  });

  it("addHost() optimistically shows the host then reconciles to the server truth", async () => {
    const { calls } = stubFetch({ globalEnabled: true, globalHosts: ["api.example.com"] });
    await useEgressStore.getState().addHost("api.example.com");
    expect(useEgressStore.getState().globalHosts).toEqual(["api.example.com"]);
    expect(calls.at(-1)).toMatchObject({ url: "/api/egress/hosts", method: "POST", body: { host: "api.example.com" } });
  });

  it("addHost() ignores a blank host", async () => {
    const { calls } = stubFetch({ globalEnabled: true, globalHosts: [] });
    await useEgressStore.getState().addHost("   ");
    expect(calls).toHaveLength(0);
  });

  it("addHost() rolls back on failure", async () => {
    useEgressStore.setState({ globalHosts: ["existing.com"] });
    stubFetch({ globalEnabled: true, globalHosts: [] }, false);
    await expect(useEgressStore.getState().addHost("new.com")).rejects.toThrow();
    expect(useEgressStore.getState().globalHosts).toEqual(["existing.com"]); // reverted
  });

  it("removeHost() optimistically removes and DELETEs", async () => {
    useEgressStore.setState({ globalHosts: ["a.com", "b.com"] });
    const { calls } = stubFetch({ globalEnabled: true, globalHosts: ["b.com"] });
    await useEgressStore.getState().removeHost("a.com");
    expect(useEgressStore.getState().globalHosts).toEqual(["b.com"]);
    expect(calls.at(-1)).toMatchObject({ url: "/api/egress/hosts", method: "DELETE", body: { host: "a.com" } });
  });
});
