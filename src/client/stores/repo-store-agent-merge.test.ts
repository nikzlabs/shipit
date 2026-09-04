import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRepoStore } from "./repo-store.js";
import type { RepoInfo } from "../../server/shared/types.js";

/**
 * docs/287-agent-merge-per-repo — the agent-merge toggle is a PERMISSION, so its
 * optimistic write has to fail in the right direction.
 *
 * A rejected request is a definitive "the server did not apply this", and the
 * toggle goes back. A thrown fetch is not an answer: the PATCH may have been
 * committed and only its response lost, and quietly showing "off" over a
 * database that says "on" tells the user agents cannot merge in this repository
 * when they can.
 */

const URL = "https://github.com/owner/repo.git";

function repo(over: Partial<RepoInfo> = {}): RepoInfo {
  const now = new Date().toISOString();
  return { url: URL, addedAt: now, lastUsedAt: now, status: "ready", allowAgentMerge: false, ...over };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  useRepoStore.getState().setRepos([repo()]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function grant(): boolean | undefined {
  return useRepoStore.getState().repos.find((r) => r.url === URL)?.allowAgentMerge;
}

describe("setRepoAllowAgentMerge", () => {
  it("keeps the optimistic value when the PATCH succeeds", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);

    await expect(useRepoStore.getState().setRepoAllowAgentMerge(URL, true)).resolves.toBe(true);
    expect(grant()).toBe(true);
  });

  it("reverts on a rejected request — the server definitively did not apply it", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response);

    await expect(useRepoStore.getState().setRepoAllowAgentMerge(URL, true)).resolves.toBe(false);
    expect(grant()).toBe(false);
  });

  it("re-reads the server when the request throws, rather than guessing", async () => {
    // The dangerous sequence: the PATCH commits, the response is lost, `fetch`
    // rejects. An unconditional revert would show "off" over a granted
    // repository (cross-agent review finding).
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") throw new Error("network");
      return { ok: true, status: 200, json: async () => ({ repos: [repo({ allowAgentMerge: true })] }) } as Response;
    }) as unknown as typeof globalThis.fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(useRepoStore.getState().setRepoAllowAgentMerge(URL, true)).resolves.toBe(false);
    // The authoritative list wins: the write DID land, and the switch says so.
    expect(grant()).toBe(true);
  });

  it("falls back to the revert when even the re-read fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(useRepoStore.getState().setRepoAllowAgentMerge(URL, true)).resolves.toBe(false);
    expect(grant()).toBe(false);
  });

  it("reverts a revoke back to granted, not just to false", async () => {
    // The direction that matters for a permission: a failed REVOKE must leave
    // the switch on, because the repository is still granted.
    useRepoStore.getState().setRepos([repo({ allowAgentMerge: true })]);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);

    await useRepoStore.getState().setRepoAllowAgentMerge(URL, false);
    expect(grant()).toBe(true);
  });
});
