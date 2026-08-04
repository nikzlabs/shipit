import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { RepoStore } from "../repo-store.js";
import {
  refreshRepoDefaultBranch,
  refreshAllRepoDefaultBranches,
  repoDefaultBranch,
  FALLBACK_DEFAULT_BRANCH,
} from "./repo-default-branch.js";

const URL_A = "https://github.com/owner/master-repo.git";
const URL_B = "https://github.com/owner/trunk-repo.git";

let dbManager: DatabaseManager;
let store: RepoStore;

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  store = new RepoStore(dbManager);
});

afterEach(() => {
  dbManager.close();
});

/** Deps whose "git" is a lookup table and whose cache always exists. */
function makeDeps(
  branches: Record<string, string | Error>,
  overrides: Partial<Parameters<typeof refreshRepoDefaultBranch>[0]> = {},
) {
  return {
    repoStore: store,
    getBareCacheDir: (url: string) => `/cache/${url}`,
    cacheExists: () => Promise.resolve(true),
    createRepoGit: (dir: string) => ({
      getDefaultBranch: () => {
        const value = branches[dir];
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(value ?? "main");
      },
    }),
    ...overrides,
  };
}

describe("refreshRepoDefaultBranch", () => {
  it("stores the branch the bare cache's HEAD actually points at", async () => {
    store.add(URL_A);
    const deps = makeDeps({ [`/cache/${URL_A}`]: "master" });

    await expect(refreshRepoDefaultBranch(deps, URL_A)).resolves.toBe("master");
    expect(store.get(URL_A)?.defaultBranch).toBe("master");
  });

  it("broadcasts the updated repo list so open tabs pick the value up", async () => {
    store.add(URL_A);
    const sseBroadcast = vi.fn();
    await refreshRepoDefaultBranch(makeDeps({ [`/cache/${URL_A}`]: "master" }, { sseBroadcast }), URL_A);

    expect(sseBroadcast).toHaveBeenCalledTimes(1);
    const [event, payload] = sseBroadcast.mock.calls[0] as [string, { repos: { defaultBranch?: string }[] }];
    expect(event).toBe("repo_list");
    expect(payload.repos[0].defaultBranch).toBe("master");
  });

  it("does not re-broadcast when the value is unchanged", async () => {
    store.add(URL_A);
    const sseBroadcast = vi.fn();
    const deps = makeDeps({ [`/cache/${URL_A}`]: "master" }, { sseBroadcast });

    await refreshRepoDefaultBranch(deps, URL_A);
    await refreshRepoDefaultBranch(deps, URL_A);

    expect(sseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("leaves the stored value alone when the bare cache isn't on disk yet", async () => {
    store.add(URL_A);
    store.setDefaultBranch(URL_A, "master");
    const deps = makeDeps({ [`/cache/${URL_A}`]: "main" }, { cacheExists: () => Promise.resolve(false) });

    await expect(refreshRepoDefaultBranch(deps, URL_A)).resolves.toBeUndefined();
    expect(store.get(URL_A)?.defaultBranch).toBe("master");
  });

  it("swallows a git failure rather than overwriting with a guess", async () => {
    store.add(URL_A);
    store.setDefaultBranch(URL_A, "master");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = makeDeps({ [`/cache/${URL_A}`]: new Error("not a git repository") });
      await expect(refreshRepoDefaultBranch(deps, URL_A)).resolves.toBeUndefined();
      expect(store.get(URL_A)?.defaultBranch).toBe("master");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("refreshAllRepoDefaultBranches", () => {
  it("resolves every tracked repo and broadcasts once", async () => {
    store.add(URL_A);
    store.add(URL_B);
    const sseBroadcast = vi.fn();

    await refreshAllRepoDefaultBranches(
      makeDeps({ [`/cache/${URL_A}`]: "master", [`/cache/${URL_B}`]: "trunk" }, { sseBroadcast }),
    );

    expect(store.get(URL_A)?.defaultBranch).toBe("master");
    expect(store.get(URL_B)?.defaultBranch).toBe("trunk");
    expect(sseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("stays silent when nothing changed (the steady state on every boot)", async () => {
    store.add(URL_A);
    store.setDefaultBranch(URL_A, "master");
    const sseBroadcast = vi.fn();

    await refreshAllRepoDefaultBranches(makeDeps({ [`/cache/${URL_A}`]: "master" }, { sseBroadcast }));

    expect(sseBroadcast).not.toHaveBeenCalled();
  });
});

describe("repoDefaultBranch", () => {
  it("falls back to main for an untracked or unresolved repo", () => {
    expect(repoDefaultBranch(store, undefined)).toBe(FALLBACK_DEFAULT_BRANCH);
    expect(repoDefaultBranch(store, URL_A)).toBe(FALLBACK_DEFAULT_BRANCH);
    store.add(URL_A);
    expect(repoDefaultBranch(store, URL_A)).toBe(FALLBACK_DEFAULT_BRANCH);
  });

  it("returns the resolved branch", () => {
    store.add(URL_A);
    store.setDefaultBranch(URL_A, "master");
    expect(repoDefaultBranch(store, URL_A)).toBe("master");
  });

  it("matches a session remoteUrl that differs only by .git suffix", () => {
    store.add(URL_A);
    store.setDefaultBranch(URL_A, "master");
    expect(repoDefaultBranch(store, "https://github.com/owner/master-repo")).toBe("master");
  });
});
