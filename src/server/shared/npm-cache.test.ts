import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  linkSessionNpmCache,
  prepareSessionNpmCache,
  pruneSharedNpmIndex,
  sessionNpmCacheDir,
  sharedNpmContentDir,
  sharedNpmIndexDir,
} from "./npm-cache.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-cache-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function dirs(): { stateDir: string; depCacheDir: string; cacheRoot: string; link: string } {
  const stateDir = path.join(root, "session-state");
  const depCacheDir = path.join(root, "dep-cache", "repohash");
  const cacheRoot = sessionNpmCacheDir(stateDir);
  return { stateDir, depCacheDir, cacheRoot, link: path.join(cacheRoot, "_cacache", "content-v2") };
}

describe("sessionNpmCacheDir", () => {
  it("keeps the npm cache inside the per-session state mount, never in the shared dep cache", () => {
    expect(sessionNpmCacheDir()).toBe("/session-state/npm-cache");
    expect(sessionNpmCacheDir("/session-state")).not.toContain("/dep-cache");
  });
});

describe("prepareSessionNpmCache", () => {
  it("creates a private cache root whose content-v2 links to the shared store", () => {
    const { depCacheDir, cacheRoot, link } = dirs();
    const outcome = prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));

    expect(outcome).toEqual({ shared: true, relinked: true, discardedPrivateContent: false });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(sharedNpmContentDir(depCacheDir));
    expect(fs.statSync(sharedNpmContentDir(depCacheDir)).isDirectory()).toBe(true);
  });

  it("leaves index-v5 out of the shared cache — the whole point of the split", () => {
    const { depCacheDir, cacheRoot } = dirs();
    prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));
    fs.mkdirSync(path.join(cacheRoot, "_cacache", "index-v5", "aa", "bb"), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "_cacache", "index-v5", "aa", "bb", "entry"), "x");

    expect(fs.existsSync(sharedNpmIndexDir(depCacheDir))).toBe(false);
  });

  it("is idempotent across container restarts", () => {
    const { depCacheDir, cacheRoot } = dirs();
    prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));
    const again = prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));

    expect(again).toEqual({ shared: true, relinked: false, discardedPrivateContent: false });
  });

  it("repoints a link left behind by a different dep cache", () => {
    const { depCacheDir, cacheRoot, link } = dirs();
    const stale = path.join(root, "dep-cache", "otherrepo");
    prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(stale));
    const outcome = prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));

    expect(outcome).toEqual({ shared: true, relinked: true, discardedPrivateContent: false });
    expect(fs.readlinkSync(link)).toBe(sharedNpmContentDir(depCacheDir));
  });

  // `npm cache clean --force` removes the whole cache root, link included, so the next
  // install fills a real content-v2 directory. Left alone, that session never shares again.
  it("discards unshared content npm wrote after the link was removed", () => {
    const { depCacheDir, cacheRoot, link } = dirs();
    fs.mkdirSync(path.join(link, "sha512", "aa"), { recursive: true });
    fs.writeFileSync(path.join(link, "sha512", "aa", "blob"), "private");

    const outcome = prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));

    expect(outcome).toEqual({ shared: true, relinked: true, discardedPrivateContent: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("reports a reason instead of throwing when the layout cannot be created", () => {
    const { depCacheDir, cacheRoot } = dirs();
    fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });
    fs.writeFileSync(cacheRoot, "not a directory");

    const outcome = prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));

    expect(outcome.shared).toBe(false);
  });

  // A link npm follows into a store that is not there is worse than no link: it reports
  // unshared while npm still fails to write content.
  it("removes a link it cannot honour, so an unshared cache really is a working one", () => {
    const { depCacheDir, cacheRoot, link } = dirs();
    prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));
    // The shared store's path is now occupied by a file, so it can never be a content dir.
    fs.rmSync(sharedNpmContentDir(depCacheDir), { recursive: true, force: true });
    fs.writeFileSync(sharedNpmContentDir(depCacheDir), "not a directory");

    const outcome = prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));

    expect(outcome.shared).toBe(false);
    expect(fs.existsSync(link)).toBe(false);
  });

  it("keeps a real content directory when the share cannot be established", () => {
    const { depCacheDir, cacheRoot, link } = dirs();
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(path.join(link, "blob"), "this session's own content");
    fs.mkdirSync(path.dirname(sharedNpmContentDir(depCacheDir)), { recursive: true });
    fs.writeFileSync(sharedNpmContentDir(depCacheDir), "not a directory");

    const outcome = prepareSessionNpmCache(cacheRoot, sharedNpmContentDir(depCacheDir));

    expect(outcome.shared).toBe(false);
    expect(fs.readFileSync(path.join(link, "blob"), "utf-8")).toBe("this session's own content");
  });
});

describe("linkSessionNpmCache", () => {
  it("prepares the split only for the cache path the orchestrator selected", () => {
    const { stateDir, depCacheDir, cacheRoot } = dirs();
    const outcome = linkSessionNpmCache(stateDir, depCacheDir, { npm_config_cache: cacheRoot });

    expect(outcome).toEqual({ shared: true, relinked: true, discardedPrivateContent: false });
  });

  it("retires the shared resolution index as the session uid, which owns the group write", () => {
    const { stateDir, depCacheDir, cacheRoot } = dirs();
    fs.mkdirSync(sharedNpmIndexDir(depCacheDir), { recursive: true });
    fs.writeFileSync(path.join(sharedNpmIndexDir(depCacheDir), "stale"), "packument");

    linkSessionNpmCache(stateDir, depCacheDir, { npm_config_cache: cacheRoot });

    expect(fs.existsSync(sharedNpmIndexDir(depCacheDir))).toBe(false);
  });

  it("does nothing for a session with no shared dep cache, which keeps npm's own default", () => {
    const { stateDir, depCacheDir, cacheRoot } = dirs();

    expect(linkSessionNpmCache(stateDir, depCacheDir, {})).toBeNull();
    expect(linkSessionNpmCache(stateDir, depCacheDir, { npm_config_cache: "/home/shipit/.npm" }))
      .toBeNull();
    expect(fs.existsSync(cacheRoot)).toBe(false);
  });
});

describe("pruneSharedNpmIndex", () => {
  it("removes the shared resolution index that H1 was exploitable through", () => {
    const { depCacheDir } = dirs();
    const bucket = path.join(sharedNpmIndexDir(depCacheDir), "aa", "bb");
    fs.mkdirSync(bucket, { recursive: true });
    fs.writeFileSync(path.join(bucket, "poisoned"), "packument");
    fs.mkdirSync(sharedNpmContentDir(depCacheDir), { recursive: true });
    fs.writeFileSync(path.join(sharedNpmContentDir(depCacheDir), "blob"), "content");

    expect(pruneSharedNpmIndex(depCacheDir)).toBe(true);
    expect(fs.existsSync(sharedNpmIndexDir(depCacheDir))).toBe(false);
    // Content is what the sharing is for; only resolution data is retired.
    expect(fs.existsSync(path.join(sharedNpmContentDir(depCacheDir), "blob"))).toBe(true);
  });

  it("is a no-op once retired", () => {
    const { depCacheDir } = dirs();
    expect(pruneSharedNpmIndex(depCacheDir)).toBe(false);
  });
});
