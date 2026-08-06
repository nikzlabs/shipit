import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { RepoStore } from "../repo-store.js";
import { REPO_COLOR_COUNT } from "../../shared/repo-colors.js";
import { setRepoColorIndex } from "./repos.js";
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
});
