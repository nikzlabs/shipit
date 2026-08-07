import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRepoStore } from "./repo-store.js";
import type { RepoInfo } from "../../server/shared/types.js";

/**
 * docs/254 — the optimistic path for the per-repo identity color.
 *
 * The interesting cases are all about ORDERING: a colour click is cheap and
 * users click several in a row while trying them out, so two or three PATCHes
 * are routinely in flight against the same repo.
 */

const now = new Date().toISOString();
const url = "https://github.com/owner/repo.git";
const base: RepoInfo = { url, status: "ready", addedAt: now, lastUsedAt: now, colorIndex: 0 };

const colorOf = () => useRepoStore.getState().repos.find((r) => r.url === url)?.colorIndex;

/** A fetch stub whose responses are resolved by hand, in any order. */
function deferredFetch() {
  const pending: { colorIndex: number; settle: (ok: boolean) => void }[] = [];
  const stub = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    const colorIndex = (JSON.parse(body) as { colorIndex: number }).colorIndex;
    return new Promise<Response>((resolve) => {
      pending.push({ colorIndex, settle: (ok) => resolve({ ok } as Response) });
    });
  });
  return {
    stub,
    settle(colorIndex: number, ok: boolean) {
      const i = pending.findIndex((p) => p.colorIndex === colorIndex);
      if (i === -1) throw new Error(`no in-flight request for colorIndex ${colorIndex}`);
      pending.splice(i, 1)[0].settle(ok);
    },
  };
}

beforeEach(() => {
  useRepoStore.setState({ repos: [{ ...base }] });
});

afterEach(() => {
  useRepoStore.setState({ repos: [] });
  vi.unstubAllGlobals();
});

describe("setRepoColorIndex", () => {
  it("applies the new color optimistically, before the request settles", async () => {
    const { stub } = deferredFetch();
    vi.stubGlobal("fetch", stub);
    void useRepoStore.getState().setRepoColorIndex(url, 7);
    expect(colorOf()).toBe(7);
  });

  it("keeps the new color when the request succeeds", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.stub);
    const p = useRepoStore.getState().setRepoColorIndex(url, 7);
    f.settle(7, true);
    await expect(p).resolves.toBe(true);
    expect(colorOf()).toBe(7);
  });

  it("rolls back to the previous color when the request fails", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.stub);
    const p = useRepoStore.getState().setRepoColorIndex(url, 7);
    f.settle(7, false);
    await expect(p).resolves.toBe(false);
    expect(colorOf()).toBe(0);
  });

  /**
   * The regression this guards: click 1, then 2. Request 2 succeeds and is the
   * value the server now holds; request 1 then fails. An unconditional rollback
   * would restore 0 — discarding a newer, server-confirmed colour — and the
   * authoritative `repo_list` SSE has already been consumed, so nothing would
   * correct it until the next reload.
   */
  it("does not let a stale failure stomp a newer successful color", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.stub);
    const first = useRepoStore.getState().setRepoColorIndex(url, 1);
    const second = useRepoStore.getState().setRepoColorIndex(url, 2);
    f.settle(2, true);
    await second;
    f.settle(1, false);
    await first;
    expect(colorOf()).toBe(2);
  });

  // Same hazard, arriving from the server instead of from another click.
  it("does not stomp an authoritative repo_list update that landed first", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.stub);
    const p = useRepoStore.getState().setRepoColorIndex(url, 7);
    // SSE broadcast re-sets the list while our PATCH is still in flight.
    useRepoStore.setState({ repos: [{ ...base, colorIndex: 12 }] });
    f.settle(7, false);
    await p;
    expect(colorOf()).toBe(12);
  });

  it("rolls back a network error the same way as a rejected response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(useRepoStore.getState().setRepoColorIndex(url, 7)).resolves.toBe(false);
    expect(colorOf()).toBe(0);
  });
});
