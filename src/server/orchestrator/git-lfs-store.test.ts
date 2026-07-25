import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  lfsSharedStoreEnabled,
  lfsObjectsDir,
  linkLfsObjectsIntoClone,
  fetchLfsIntoCache,
  resolveCacheFetchRef,
} from "./git-lfs-store.js";

/** `<ab>/<cd>/<oid>` — the two-level fanout git-lfs writes. */
function writeCacheObject(cacheDir: string, oid: string, content: string): string {
  const p = path.join(lfsObjectsDir(cacheDir, true), oid.slice(0, 2), oid.slice(2, 4), oid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function clonePathFor(sessionDir: string, oid: string): string {
  return path.join(lfsObjectsDir(sessionDir, false), oid.slice(0, 2), oid.slice(2, 4), oid);
}

describe("git-lfs-store", () => {
  let tmpDir: string;
  let cacheDir: string;
  let sessionDir: string;
  let savedFlag: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfs-store-"));
    cacheDir = path.join(tmpDir, "repo-cache", "abc123");
    sessionDir = path.join(tmpDir, "sessions", "s1");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(path.join(sessionDir, ".git"), { recursive: true });
    savedFlag = process.env.SHIPIT_GIT_LFS_SHARED_STORE;
    process.env.SHIPIT_GIT_LFS_SHARED_STORE = "1";
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.SHIPIT_GIT_LFS_SHARED_STORE;
    else process.env.SHIPIT_GIT_LFS_SHARED_STORE = savedFlag;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("lfsSharedStoreEnabled", () => {
    it("is ON when unset — sharing is the default", () => {
      delete process.env.SHIPIT_GIT_LFS_SHARED_STORE;
      expect(lfsSharedStoreEnabled()).toBe(true);
    });

    // An empty value is what a compose "VAR:-" passthrough supplies when the
    // operator has set nothing, so it must read as the default, not as off.
    it("is ON for an empty value", () => {
      process.env.SHIPIT_GIT_LFS_SHARED_STORE = "";
      expect(lfsSharedStoreEnabled()).toBe(true);
    });

    it.each(["0", "off", "OFF", " off ", "false", "no"])("is off for %j", (value) => {
      process.env.SHIPIT_GIT_LFS_SHARED_STORE = value;
      expect(lfsSharedStoreEnabled()).toBe(false);
    });

    it.each(["1", "true", "on", "ON", " true "])("stays on for the old opt-in value %j", (value) => {
      process.env.SHIPIT_GIT_LFS_SHARED_STORE = value;
      expect(lfsSharedStoreEnabled()).toBe(true);
    });

    it.each(["yes", "enabled", "please"])("treats an unrecognized value %j as the default (on)", (value) => {
      process.env.SHIPIT_GIT_LFS_SHARED_STORE = value;
      expect(lfsSharedStoreEnabled()).toBe(true);
    });
  });

  describe("lfsObjectsDir", () => {
    it("uses lfs/objects in a bare cache and .git/lfs/objects in a clone", () => {
      expect(lfsObjectsDir("/c", true)).toBe(path.join("/c", "lfs", "objects"));
      expect(lfsObjectsDir("/s", false)).toBe(path.join("/s", ".git", "lfs", "objects"));
    });
  });

  describe("linkLfsObjectsIntoClone", () => {
    it("hardlinks cache objects into the clone, preserving the fanout", () => {
      const oid = "abcdef0123456789";
      const srcPath = writeCacheObject(cacheDir, oid, "REAL-ASSET-BYTES");

      const stats = linkLfsObjectsIntoClone(cacheDir, sessionDir);

      expect(stats).toMatchObject({ linked: 1, copied: 0, failed: 0 });
      const dstPath = clonePathFor(sessionDir, oid);
      expect(fs.readFileSync(dstPath, "utf8")).toBe("REAL-ASSET-BYTES");
      // The point of the exercise: one inode, so the bytes cost disk once and
      // the object survives in the clone even if the cache later drops its link.
      expect(fs.statSync(dstPath).ino).toBe(fs.statSync(srcPath).ino);
    });

    it("shares one inode across two clones of the same cache", () => {
      const oid = "1122334455667788";
      writeCacheObject(cacheDir, oid, "shared");
      const other = path.join(tmpDir, "sessions", "s2");
      fs.mkdirSync(path.join(other, ".git"), { recursive: true });

      linkLfsObjectsIntoClone(cacheDir, sessionDir);
      linkLfsObjectsIntoClone(cacheDir, other);

      expect(fs.statSync(clonePathFor(sessionDir, oid)).ino).toBe(fs.statSync(clonePathFor(other, oid)).ino);
    });

    it("survives the cache dropping its link — kernel refcounting, not a shared store", () => {
      const oid = "deadbeefdeadbeef";
      const srcPath = writeCacheObject(cacheDir, oid, "still-here");
      linkLfsObjectsIntoClone(cacheDir, sessionDir);

      // This is what a cache-side `git lfs prune` does. It must not be able to
      // pull content out from under a live session.
      fs.rmSync(srcPath);

      expect(fs.readFileSync(clonePathFor(sessionDir, oid), "utf8")).toBe("still-here");
    });

    it("walks the whole fanout, linking every object", () => {
      const oids = ["aa00000000000001", "aa11000000000002", "bb22000000000003"];
      for (const oid of oids) writeCacheObject(cacheDir, oid, `body-${oid}`);

      const stats = linkLfsObjectsIntoClone(cacheDir, sessionDir);

      expect(stats.linked).toBe(3);
      for (const oid of oids) {
        expect(fs.readFileSync(clonePathFor(sessionDir, oid), "utf8")).toBe(`body-${oid}`);
      }
    });

    it("counts an object the clone already has as present, leaving it untouched", () => {
      const oid = "cafebabecafebabe";
      writeCacheObject(cacheDir, oid, "from-cache");
      const dstPath = clonePathFor(sessionDir, oid);
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.writeFileSync(dstPath, "already-downloaded");

      const stats = linkLfsObjectsIntoClone(cacheDir, sessionDir);

      expect(stats).toMatchObject({ linked: 0, present: 1, failed: 0 });
      expect(fs.readFileSync(dstPath, "utf8")).toBe("already-downloaded");
    });

    it("is a no-op when explicitly disabled, even with a populated cache", () => {
      process.env.SHIPIT_GIT_LFS_SHARED_STORE = "off";
      const oid = "0000111122223333";
      writeCacheObject(cacheDir, oid, "x");

      const stats = linkLfsObjectsIntoClone(cacheDir, sessionDir);

      expect(stats).toEqual({ linked: 0, copied: 0, present: 0, failed: 0 });
      expect(fs.existsSync(clonePathFor(sessionDir, oid))).toBe(false);
    });

    it("no-ops when the cache has no LFS store (a non-LFS repo)", () => {
      const stats = linkLfsObjectsIntoClone(cacheDir, sessionDir);
      expect(stats).toEqual({ linked: 0, copied: 0, present: 0, failed: 0 });
      expect(fs.existsSync(lfsObjectsDir(sessionDir, false))).toBe(false);
    });

    it("skips symlinks in the cache store rather than following them out of the tree", () => {
      const outside = path.join(tmpDir, "outside-secret");
      fs.writeFileSync(outside, "should-not-be-copied");
      const fanout = path.join(lfsObjectsDir(cacheDir, true), "ab", "cd");
      fs.mkdirSync(fanout, { recursive: true });
      fs.symlinkSync(outside, path.join(fanout, "ffffffffffffffff"));

      const stats = linkLfsObjectsIntoClone(cacheDir, sessionDir);

      expect(stats).toEqual({ linked: 0, copied: 0, present: 0, failed: 0 });
      expect(fs.existsSync(path.join(lfsObjectsDir(sessionDir, false), "ab", "cd", "ffffffffffffffff"))).toBe(false);
    });

    it("does not leave empty fanout dirs behind for an empty cache dir", () => {
      fs.mkdirSync(path.join(lfsObjectsDir(cacheDir, true), "ab", "cd"), { recursive: true });

      linkLfsObjectsIntoClone(cacheDir, sessionDir);

      expect(fs.existsSync(path.join(lfsObjectsDir(sessionDir, false), "ab", "cd"))).toBe(false);
    });

    it("never throws, and reports failures, when the destination can't be created", () => {
      writeCacheObject(cacheDir, "aabbccddeeff0011", "x");
      // A regular file as the session dir makes every mkdir under it ENOTDIR —
      // an unwritable destination that fails fast on any platform. (Do NOT reach
      // for a /proc path here: `fs.mkdirSync(recursive)` under /proc spins
      // instead of erroring in a container, which hangs the run rather than
      // failing it.)
      const notADir = path.join(tmpDir, "sessions", "a-file-not-a-dir");
      fs.writeFileSync(notADir, "");

      let stats: ReturnType<typeof linkLfsObjectsIntoClone> | undefined;
      expect(() => (stats = linkLfsObjectsIntoClone(cacheDir, notADir))).not.toThrow();
      expect(stats).toMatchObject({ linked: 0, failed: 1 });
    });
  });

  describe("resolveCacheFetchRef", () => {
    /**
     * A bare repo with one branch. `headRef` sets the HEAD symref — pass a
     * nonexistent branch to reproduce the dangling-HEAD case that makes the
     * no-ref `git lfs fetch origin` fail outright.
     */
    function makeBareRepo(name: string, branch: string | null, headRef?: string): string {
      const bare = path.join(tmpDir, name);
      const work = path.join(tmpDir, `${name}-work`);
      run(["init", "--quiet", "--bare", bare]);
      if (branch) {
        run(["init", "--quiet", work]);
        run(["-C", work, "config", "user.email", "t@t"]);
        run(["-C", work, "config", "user.name", "t"]);
        fs.writeFileSync(path.join(work, "f.txt"), "hi");
        run(["-C", work, "add", "-A"]);
        run(["-C", work, "commit", "--quiet", "-m", "init"]);
        run(["-C", work, "push", "--quiet", bare, `HEAD:refs/heads/${branch}`]);
      }
      if (headRef) run(["-C", bare, "symbolic-ref", "HEAD", headRef]);
      return bare;
    }

    function run(args: string[]): void {
      const res = spawnSync("git", args, { encoding: "utf8" });
      if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }

    it("returns HEAD's branch when HEAD resolves", async () => {
      const bare = makeBareRepo("valid", "main", "refs/heads/main");
      await expect(resolveCacheFetchRef(bare)).resolves.toBe("main");
    });

    it("falls back to an existing branch when HEAD dangles", async () => {
      // The regression this guards: `git init --bare` leaves HEAD on
      // refs/heads/master, and a repo whose only branch is `main` (or whose
      // default branch was renamed and pruned) has an unresolvable HEAD. The
      // no-ref `git lfs fetch origin` fails hard there and fetches nothing.
      const bare = makeBareRepo("dangling", "main", "refs/heads/does-not-exist");
      await expect(resolveCacheFetchRef(bare)).resolves.toBe("main");
    });

    it("returns null for a repo with no branches at all", async () => {
      const bare = makeBareRepo("empty", null);
      await expect(resolveCacheFetchRef(bare)).resolves.toBeNull();
    });

    it("returns null rather than throwing for a directory that isn't a repo", async () => {
      await expect(resolveCacheFetchRef(cacheDir)).resolves.toBeNull();
    });
  });

  describe("fetchLfsIntoCache", () => {
    it("does not shell out at all when explicitly disabled", async () => {
      process.env.SHIPIT_GIT_LFS_SHARED_STORE = "off";
      // No git repo here, so any real `git grep`/`git lfs fetch` would fail —
      // returning false without touching git is the observable contract.
      await expect(fetchLfsIntoCache(cacheDir)).resolves.toBe(false);
    });

    it("returns false for a directory that isn't a repo, without throwing", async () => {
      await expect(fetchLfsIntoCache(cacheDir)).resolves.toBe(false);
    });

    it("reports false when the git-lfs binary is unavailable", async () => {
      // `repoDeclaresLfs` runs first and answers "no" for a non-repo, so this
      // asserts the no-throw contract of the unavailable path rather than
      // reaching the probe — the binary branch is covered in git-lfs.test.ts.
      await expect(fetchLfsIntoCache(cacheDir, { isAvailable: async () => false })).resolves.toBe(false);
    });
  });
});
