import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { RepoStore } from "../repo-store.js";
import { REPO_COLOR_COUNT } from "../../shared/repo-colors.js";
import { addRepo, setRepoColorIndex, assertValidRepoColorIndex, setRepoHidden } from "./repos.js";
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

// docs/254 — the color is user-supplied, so the service is the boundary that
// keeps an unrenderable index out of the database.
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

  // The route validates the WHOLE body up front via this assert, so a PATCH
  // carrying a good `hidden` and a bad `colorIndex` writes neither.
  it("exposes a standalone assert the route can run before any write", () => {
    expect(() => assertValidRepoColorIndex(0)).not.toThrow();
    expect(() => assertValidRepoColorIndex(REPO_COLOR_COUNT)).toThrow(ServiceError);
    expect(() => assertValidRepoColorIndex("2")).toThrow(ServiceError);
  });

  // docs/262 req 19 — the credential a user types into the Add-repo field is
  // dropped, not stored. Everything downstream (the bare cache's origin, every
  // session clone's `/project/.git/config`) is written from this stored value,
  // so this is where the credential would otherwise enter the system.
  it("drops a credential typed into the repository URL", () => {
    const repo = addRepo(repoStore, "https://x-access-token:pw@github.com/owner/other.git");
    expect(repo.url).toBe("https://github.com/owner/other.git");
    expect(repoStore.list().map((r) => r.url)).not.toContain(
      "https://x-access-token:pw@github.com/owner/other.git",
    );
  });

  // The credentialed spelling and the clean one are ONE repository: the follow-up
  // calls (`setReady`, `setWarmSessionId`) address the row by the URL the caller
  // has, and a strip that only ran in `add` would leave them addressing nothing.
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
    // What the route does: validate everything, then write.
    expect(() => assertValidRepoColorIndex(99)).toThrow(ServiceError);
    expect(repoStore.get(url)?.hidden).toBe(false);
    expect(repoStore.get(url)?.colorIndex).toBe(5);
  });
});
