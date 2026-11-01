import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { compactAfterMergeEnabled, useSessionStore } from "./session-store.js";

const details = (compactAfterMergeOff: boolean) => ({ sessionStatus: null, agentGoal: null, compactAfterMergeOff });

beforeEach(() => {
  useSessionStore.setState({ sessionDetails: { s1: details(false) }, pendingCompactAfterMerge: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setCompactAfterMerge (docs/295-compact-context-on-merge reqs 5, 16)", () => {
  it("saves one session's clicks one after another, so the last click is the saved choice", async () => {
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      if (bodies.length === 1) await firstHeld;
      return new Response("{}", { status: 200 });
    }));

    const off = useSessionStore.getState().setCompactAfterMerge("s1", false);
    const on = useSessionStore.getState().setCompactAfterMerge("s1", true);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(compactAfterMergeEnabled(useSessionStore.getState(), "s1")).toBe(true);

    releaseFirst();
    await Promise.all([off, on]);
    expect(bodies).toEqual([JSON.stringify({ enabled: false }), JSON.stringify({ enabled: true })]);
    expect(useSessionStore.getState().sessionDetails.s1?.compactAfterMergeOff).toBe(false);
    expect(useSessionStore.getState().pendingCompactAfterMerge).toEqual({});
  });

  it("shows the click, not an older server answer that arrives before the click is saved", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => { await held; return new Response("{}", { status: 200 }); }));

    const write = useSessionStore.getState().setCompactAfterMerge("s1", false);
    useSessionStore.getState().setSessionDetails("s1", details(false));
    expect(compactAfterMergeEnabled(useSessionStore.getState(), "s1")).toBe(false);

    release();
    await write;
    expect(compactAfterMergeEnabled(useSessionStore.getState(), "s1")).toBe(false);
  });

  it("keeps a saved click when a session switch emptied the details before the answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const write = useSessionStore.getState().setCompactAfterMerge("s1", false);
    useSessionStore.setState({ sessionDetails: {} });
    await write;
    expect(compactAfterMergeEnabled(useSessionStore.getState(), "s1")).toBe(false);
  });

  it("goes back to the server's value when the write is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await useSessionStore.getState().setCompactAfterMerge("s1", false);
    expect(compactAfterMergeEnabled(useSessionStore.getState(), "s1")).toBe(true);
    expect(useSessionStore.getState().pendingCompactAfterMerge).toEqual({});
  });
});
