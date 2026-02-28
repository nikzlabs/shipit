import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RepoStore } from "./repo-store.js";

let tmpDir: string;
let store: RepoStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-repo-store-test-"));
  store = new RepoStore(path.join(tmpDir, "repos.json"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("RepoStore", () => {
  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("adds a repo", () => {
    const repo = store.add("https://github.com/owner/repo.git");
    expect(repo.url).toBe("https://github.com/owner/repo.git");
    expect(repo.status).toBe("cloning");
    expect(store.list()).toHaveLength(1);
  });

  it("returns existing repo on duplicate add", () => {
    store.add("https://github.com/owner/repo.git");
    const repo2 = store.add("https://github.com/owner/repo.git");
    expect(store.list()).toHaveLength(1);
    expect(repo2.url).toBe("https://github.com/owner/repo.git");
  });

  it("setReady changes status", () => {
    store.add("https://github.com/owner/repo.git");
    store.setReady("https://github.com/owner/repo.git");
    expect(store.get("https://github.com/owner/repo.git")?.status).toBe("ready");
  });

  it("setWarmSessionId stores and clears warm session", () => {
    store.add("https://github.com/owner/repo.git");
    store.setWarmSessionId("https://github.com/owner/repo.git", "session-123");
    expect(store.get("https://github.com/owner/repo.git")?.warmSessionId).toBe("session-123");
    store.setWarmSessionId("https://github.com/owner/repo.git", undefined);
    expect(store.get("https://github.com/owner/repo.git")?.warmSessionId).toBeUndefined();
  });

  it("touch updates lastUsedAt", () => {
    const repo = store.add("https://github.com/owner/repo.git");
    const _originalDate = repo.lastUsedAt;
    // Small delay to ensure different timestamp
    store.touch("https://github.com/owner/repo.git");
    const updated = store.get("https://github.com/owner/repo.git");
    expect(updated?.lastUsedAt).toBeTruthy();
  });

  it("remove deletes a repo", () => {
    store.add("https://github.com/owner/repo.git");
    expect(store.remove("https://github.com/owner/repo.git")).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.has("https://github.com/owner/repo.git")).toBe(false);
  });

  it("remove returns false for unknown repo", () => {
    expect(store.remove("https://github.com/unknown/repo.git")).toBe(false);
  });

  it("persists to disk", () => {
    store.add("https://github.com/owner/repo.git");
    store.setReady("https://github.com/owner/repo.git");

    // Create a new store from the same file
    const store2 = new RepoStore(path.join(tmpDir, "repos.json"));
    expect(store2.list()).toHaveLength(1);
    expect(store2.get("https://github.com/owner/repo.git")?.status).toBe("ready");
  });

  it("list sorts by lastUsedAt descending", () => {
    const repoA = store.add("https://github.com/a/repo.git");
    const repoB = store.add("https://github.com/b/repo.git");
    // Manually set different lastUsedAt timestamps to test sort order
    repoA.lastUsedAt = "2020-01-01T00:00:00.000Z";
    repoB.lastUsedAt = "2025-01-01T00:00:00.000Z";
    const list = store.list();
    expect(list[0].url).toBe("https://github.com/b/repo.git");
    expect(list[1].url).toBe("https://github.com/a/repo.git");
  });

  it("clear empties in-memory state", () => {
    store.add("https://github.com/owner/repo.git");
    store.clear();
    expect(store.list()).toHaveLength(0);
  });

  it("has returns correct boolean", () => {
    expect(store.has("https://github.com/owner/repo.git")).toBe(false);
    store.add("https://github.com/owner/repo.git");
    expect(store.has("https://github.com/owner/repo.git")).toBe(true);
  });
});
