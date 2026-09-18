import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { RepoStore } from "../repo-store.js";
import { REPO_COLOR_COUNT } from "../../shared/repo-colors.js";
import { addRepo, ensureRepoReady, setRepoColorIndex, assertValidRepoColorIndex, setRepoHidden } from "./repos.js";
import { ServiceError } from "./types.js";

let dbManager: DatabaseManager;
let repoStore: RepoStore;
const url = "https://github.com/owner/repo.git";

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  repoStore = new RepoStore(dbManager);
  repoStore.add(url);
});

afterEach(() => {
  dbManager.close();
});

describe("setRepoColorIndex", () => {
  it("stores a valid index", () => {
    setRepoColorIndex(repoStore, url, 9);
    expect(repoStore.get(url)?.colorIndex).toBe(9);
  });

  it("rejects an out-of-range index", () => {
    expect(() => setRepoColorIndex(repoStore, url, REPO_COLOR_COUNT)).toThrow(ServiceError);
    expect(() => setRepoColorIndex(repoStore, url, -1)).toThrow(ServiceError);
  });

  it("rejects a non-integer index", () => {
    expect(() => setRepoColorIndex(repoStore, url, 2.5)).toThrow(ServiceError);
    expect(() => setRepoColorIndex(repoStore, url, "4")).toThrow(ServiceError);
    expect(() => setRepoColorIndex(repoStore, url, null)).toThrow(ServiceError);
  });

  it("leaves the stored color untouched when it rejects", () => {
    setRepoColorIndex(repoStore, url, 6);
    expect(() => setRepoColorIndex(repoStore, url, 999)).toThrow(ServiceError);
    expect(repoStore.get(url)?.colorIndex).toBe(6);
  });

  it("requires a url", () => {
    expect(() => setRepoColorIndex(repoStore, "", 1)).toThrow(ServiceError);
    expect(() => setRepoColorIndex(repoStore, undefined, 1)).toThrow(ServiceError);
  });

  it("404s for an untracked repo", () => {
    try {
      setRepoColorIndex(repoStore, "https://github.com/nope/nope.git", 1);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ServiceError).statusCode).toBe(404);
    }
  });

  it("reports a 400 for a bad index, not a 500", () => {
    try {
      setRepoColorIndex(repoStore, url, 99);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ServiceError).statusCode).toBe(400);
    }
  });

  it("exposes a standalone assert the route can run before any write", () => {
    expect(() => assertValidRepoColorIndex(0)).not.toThrow();
    expect(() => assertValidRepoColorIndex(REPO_COLOR_COUNT)).toThrow(ServiceError);
    expect(() => assertValidRepoColorIndex("2")).toThrow(ServiceError);
  });

  it("drops a credential typed into the repository URL", () => {
    const repo = addRepo(repoStore, "https://x-access-token:pw@github.com/owner/other.git");
    expect(repo.url).toBe("https://github.com/owner/other.git");
    expect(repoStore.list().map((r) => r.url)).not.toContain(
      "https://x-access-token:pw@github.com/owner/other.git",
    );
  });

  it("keeps a credentialed re-add on the same row it already created", () => {
    const first = addRepo(repoStore, "https://github.com/owner/same.git");
    const second = addRepo(repoStore, "https://x-access-token:pw@github.com/owner/same.git");
    expect(second.url).toBe(first.url);
    expect(repoStore.list().filter((r) => r.url.endsWith("owner/same.git"))).toHaveLength(1);
    repoStore.setReady("https://x-access-token:pw@github.com/owner/same.git");
    expect(repoStore.get("https://github.com/owner/same.git")?.status).toBe("ready");
  });

  it("leaves hidden untouched when a combined update is rejected up front", () => {
    setRepoHidden(repoStore, url, false);
    setRepoColorIndex(repoStore, url, 5);
    expect(() => assertValidRepoColorIndex(99)).toThrow(ServiceError);
    expect(repoStore.get(url)?.hidden).toBe(false);
    expect(repoStore.get(url)?.colorIndex).toBe(5);
  });
});

describe("ensureRepoReady", () => {
  it("is a no-op when the repo is already ready", async () => {
    let cloned = false;
    const key = await ensureRepoReady("https://github.com/acme/shipit.git", {
      repoStore: {
        get: () => ({ status: "ready" }),
        add: () => { throw new Error("should not add"); },
        setReady: () => { throw new Error("should not setReady"); },
        list: () => [],
      },
      getSharedRepoDir: (u) => `/cache/${u}`,
      ensureBareCache: async () => { cloned = true; },
    });
    expect(cloned).toBe(false);
    expect(key).toBe("https://github.com/acme/shipit.git");
  });

  it("registers, clones, and marks the repo ready when missing", async () => {
    const events: string[] = [];
    const key = await ensureRepoReady("https://github.com/acme/shipit.git", {
      repoStore: {
        get: () => undefined,
        add: () => events.push("add"),
        setReady: () => events.push("setReady"),
        list: () => [],
      },
      getSharedRepoDir: () => "/cache/shipit",
      ensureBareCache: async (dir) => { events.push(`clone:${dir}`); },
    });
    expect(events).toEqual(["add", "clone:/cache/shipit", "setReady"]);
    expect(key).toBe("https://github.com/acme/shipit.git");
  });

  it("reuses the user's existing entry instead of adding a duplicate for a credentialed URL", async () => {
    const userUrl = "https://github.com/acme/shipit.git";
    const store = new Map<string, { status: string }>([[userUrl, { status: "ready" }]]);
    const added: string[] = [];
    const key = await ensureRepoReady(
      "https://x-access-token:pw@GitHub.com/acme/shipit",
      {
        repoStore: {
          get: (u) => store.get(u),
          add: (u) => { added.push(u); store.set(u, { status: "cloning" }); return undefined; },
          setReady: () => { throw new Error("should not setReady"); },
          list: () => [...store.keys()].map((url) => ({ url })),
        },
        getSharedRepoDir: (u) => `/cache/${u}`,
        ensureBareCache: async () => { throw new Error("should not clone — already ready"); },
      },
    );
    expect(added).toEqual([]);
    expect(key).toBe(userUrl);
  });

  it("registers a credential-free key, never the embedded credential, when no entry exists", async () => {
    const store = new Map<string, { status: string }>();
    const added: string[] = [];
    const clonedFrom: string[] = [];
    const key = await ensureRepoReady(
      "https://x-access-token:pw@github.com/acme/shipit.git",
      {
        repoStore: {
          get: (u) => store.get(u),
          add: (u) => { added.push(u); store.set(u, { status: "cloning" }); return undefined; },
          setReady: (u) => { store.set(u, { status: "ready" }); },
          list: () => [...store.keys()].map((url) => ({ url })),
        },
        getSharedRepoDir: (u) => `/cache/${u}`,
        ensureBareCache: async (_dir, u) => { clonedFrom.push(u); },
      },
    );
    expect(key).toBe("https://github.com/acme/shipit.git");
    expect(added).toEqual(["https://github.com/acme/shipit.git"]);
    expect(JSON.stringify({ key, added, clonedFrom })).not.toContain("x-access-token");
  });
});
