import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sessionWorkerUid,
  assertWorkerUidNotReserved,
  ReservedWorkerUidError,
  RESERVED_EGRESS_UIDS,
  chownToSessionWorker,
  chownTreeToSessionWorker,
  chownWorkspaceGitToSessionWorker,
  chownWorktreeToSessionWorker,
  handWorkspaceBackToWorker,
  reconcileDepDirCacheOwnership,
  sealSessionDir,
  sealLegacySessionDirs,
  shareTreeWithAllSessions,
  sessionWorkerGid,
  identityForTarget,
  resolveGitDirOwner,
} from "./session-worker-uid.js";
import { configureSessionIdentityRoots } from "../shared/session-identity.js";
import type { GitTreeUidDeps } from "../shared/git-tree-uid.js";

describe("session-worker-uid (docs/150 §7)", () => {
  const prev = process.env.SHIPIT_SESSION_WORKER_UID;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swuid-"));
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("sessionWorkerUid()", () => {
    it("returns null when unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      expect(sessionWorkerUid()).toBeNull();
    });

    it("parses a numeric uid", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      expect(sessionWorkerUid()).toBe(1000);
    });

    it("returns null for a non-numeric value", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "shipit";
      expect(sessionWorkerUid()).toBeNull();
    });

    it("returns null for a negative value", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "-5";
      expect(sessionWorkerUid()).toBeNull();
    });
  });

  // docs/263 — the netns firewall exempts the resolver (911) and SNI proxy (912)
  // uids from the controls that name them (`init-firewall.sh` owner-match), so a
  // workload holding one escapes containment. Before this guard `sessionWorkerUid()`
  // accepted any non-negative value, so each of these returned the reserved uid.
  describe("reserved egress uids (docs/263)", () => {
    it("names exactly the resolver and proxy uids", () => {
      expect([...RESERVED_EGRESS_UIDS].sort((a, b) => a - b)).toEqual([911, 912]);
    });

    for (const uid of [911, 912]) {
      it(`refuses uid ${uid} at the parse site instead of returning it`, () => {
        process.env.SHIPIT_SESSION_WORKER_UID = String(uid);
        expect(() => sessionWorkerUid()).toThrow(ReservedWorkerUidError);
        expect(() => sessionWorkerUid()).toThrow(String(uid));
      });

      it(`fails the boot assertion for uid ${uid}`, () => {
        process.env.SHIPIT_SESSION_WORKER_UID = String(uid);
        expect(() => assertWorkerUidNotReserved()).toThrow(ReservedWorkerUidError);
      });
    }

    it("names a remedy that is not 'disable the check'", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "911";
      expect(() => sessionWorkerUid()).toThrow(/non-root UID outside/);
    });

    it("allows neighbouring uids — the refusal is the two values, not a span", () => {
      for (const uid of ["910", "913", "1000"]) {
        process.env.SHIPIT_SESSION_WORKER_UID = uid;
        expect(sessionWorkerUid()).toBe(Number(uid));
      }
    });

    it("passes the refusal on to every consumer of the parse", () => {
      // The chown helpers resolve the uid through `sessionWorkerUid()`, so a
      // reserved value cannot be silently degraded to the legacy root no-op —
      // which would leave the worker entrypoint gosu'ing to it regardless.
      process.env.SHIPIT_SESSION_WORKER_UID = "912";
      const file = path.join(tmpDir, "f");
      fs.writeFileSync(file, "x");
      expect(() => chownToSessionWorker(file)).toThrow(ReservedWorkerUidError);
    });

    it("boot assertion is a no-op for an unset or ordinary uid", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      expect(() => assertWorkerUidNotReserved()).not.toThrow();
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      expect(() => assertWorkerUidNotReserved()).not.toThrow();
    });
  });

  describe("chown gating", () => {
    it("is a no-op when SHIPIT_SESSION_WORKER_UID is unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const file = path.join(tmpDir, "f");
      fs.writeFileSync(file, "x");
      const before = fs.lstatSync(file).uid;
      chownToSessionWorker(file);
      expect(fs.lstatSync(file).uid).toBe(before);
    });

    it("never throws on a missing path", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = String(process.getuid?.() ?? 0);
      expect(() => chownToSessionWorker(path.join(tmpDir, "nope"))).not.toThrow();
      expect(() => chownTreeToSessionWorker(path.join(tmpDir, "nope"))).not.toThrow();
    });

    // Chowning to a *different* uid needs CAP_CHOWN; chowning to our OWN uid
    // always succeeds, so we exercise the real walk without requiring root.
    it("recursively chowns a subtree to the configured uid", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const sub = path.join(tmpDir, "a", "b");
      fs.mkdirSync(sub, { recursive: true });
      const file = path.join(sub, "token.json");
      fs.writeFileSync(file, "{}");
      expect(() => chownTreeToSessionWorker(tmpDir)).not.toThrow();
      expect(fs.lstatSync(file).uid).toBe(myUid);
    });

    it("chownWorkspaceGitToSessionWorker chowns <workspaceDir>/.git only", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(path.join(gitDir, "logs"), { recursive: true });
      const reflog = path.join(gitDir, "logs", "HEAD");
      fs.writeFileSync(reflog, "");
      fs.writeFileSync(path.join(gitDir, "index"), "");
      expect(() => chownWorkspaceGitToSessionWorker(tmpDir)).not.toThrow();
      expect(fs.lstatSync(reflog).uid).toBe(myUid);
      expect(fs.lstatSync(path.join(gitDir, "index")).uid).toBe(myUid);
    });

    it("chownWorkspaceGitToSessionWorker skips immutable object data files but chowns object dirs", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const gitDir = path.join(tmpDir, ".git");
      // Object store: a fanout dir with a loose object, and pack/ with a pack.
      const looseObj = path.join(gitDir, "objects", "ab", "cdef0123");
      const packFile = path.join(gitDir, "objects", "pack", "pack-x.pack");
      fs.mkdirSync(path.dirname(looseObj), { recursive: true });
      fs.mkdirSync(path.dirname(packFile), { recursive: true });
      fs.writeFileSync(looseObj, "obj");
      fs.writeFileSync(packFile, "pack");
      // Metadata that DOES get rewritten/appended → must be chowned.
      fs.mkdirSync(path.join(gitDir, "logs"), { recursive: true });
      fs.writeFileSync(path.join(gitDir, "logs", "HEAD"), "");
      fs.writeFileSync(path.join(gitDir, "index"), "");

      const spy = vi.spyOn(fs, "lchownSync");
      try {
        chownWorkspaceGitToSessionWorker(tmpDir);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        // Immutable data files: never touched (this is the O(fanout) win).
        expect(chowned.has(looseObj)).toBe(false);
        expect(chowned.has(packFile)).toBe(false);
        // Object directories: chowned so the worker can add new objects.
        expect(chowned.has(path.join(gitDir, "objects"))).toBe(true);
        expect(chowned.has(path.join(gitDir, "objects", "ab"))).toBe(true);
        expect(chowned.has(path.join(gitDir, "objects", "pack"))).toBe(true);
        // Rewritten/appended metadata: chowned.
        expect(chowned.has(path.join(gitDir, "index"))).toBe(true);
        expect(chowned.has(path.join(gitDir, "logs", "HEAD"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("chownWorkspaceGitToSessionWorker skips LFS object files but chowns their fanout dirs", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const gitDir = path.join(tmpDir, ".git");
      // docs/232: LFS uses a TWO-level fanout, `<ab>/<cd>/<oid>`.
      const lfsObjects = path.join(gitDir, "lfs", "objects");
      const lfsObj = path.join(lfsObjects, "ab", "cd", "abcdef0123");
      fs.mkdirSync(path.dirname(lfsObj), { recursive: true });
      fs.writeFileSync(lfsObj, "asset-bytes");
      // Non-object LFS metadata still gets chowned (it's rewritten in place).
      fs.writeFileSync(path.join(gitDir, "lfs", "cache-meta"), "");

      const spy = vi.spyOn(fs, "lchownSync");
      try {
        chownWorkspaceGitToSessionWorker(tmpDir);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        // The object file is a hardlink into the shared cache store — chowning it
        // would hand that store to the session uid, since an inode has one owner
        // across every link.
        expect(chowned.has(lfsObj)).toBe(false);
        // Every fanout dir IS chowned, at BOTH levels: a root-owned `ab/` would
        // stop the worker creating a new `cd/` when it commits a new asset.
        expect(chowned.has(lfsObjects)).toBe(true);
        expect(chowned.has(path.join(lfsObjects, "ab"))).toBe(true);
        expect(chowned.has(path.join(lfsObjects, "ab", "cd"))).toBe(true);
        // Ordinary `.git/lfs` metadata is unaffected by the object-store branch.
        expect(chowned.has(path.join(gitDir, "lfs", "cache-meta"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("chownWorkspaceGitToSessionWorker leaves a hardlinked LFS object owned as-is", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      // The end-to-end property docs/232 depends on: a cache object hardlinked
      // into a clone must not have its ownership rewritten by the handback.
      const cacheObj = path.join(tmpDir, "cache", "lfs", "objects", "ab", "cd", "oid1");
      fs.mkdirSync(path.dirname(cacheObj), { recursive: true });
      fs.writeFileSync(cacheObj, "shared");
      const cloneObj = path.join(tmpDir, ".git", "lfs", "objects", "ab", "cd", "oid1");
      fs.mkdirSync(path.dirname(cloneObj), { recursive: true });
      fs.linkSync(cacheObj, cloneObj);
      expect(fs.statSync(cloneObj).ino).toBe(fs.statSync(cacheObj).ino);

      const spy = vi.spyOn(fs, "lchownSync");
      try {
        chownWorkspaceGitToSessionWorker(tmpDir);
        expect(new Set(spy.mock.calls.map((c) => c[0] as string)).has(cloneObj)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    // docs/266 — NOT "a no-op when the flag is unset" any more, which is what
    // this test used to claim. The flag alone no longer gates this helper: a
    // ROOT process over a non-root-owned tree acts with the flag unset, because
    // orchestrator git drops there and needs `.git` writable
    // (`resolveGitDirOwner`). What survives is the narrower property below, and
    // it holds here only because the suite runs unprivileged.
    it("chownWorkspaceGitToSessionWorker is a no-op when not root and the flag is unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(gitDir, { recursive: true });
      const idx = path.join(gitDir, "index");
      fs.writeFileSync(idx, "");
      const before = fs.lstatSync(idx).uid;
      chownWorkspaceGitToSessionWorker(tmpDir);
      expect(fs.lstatSync(idx).uid).toBe(before);
    });

    // planning#146: the worktree handoff chowns the files the agent edits, skipping
    // `.git` (handled by the object-aware helper) and the declared dep dirs.
    it("chownWorktreeToSessionWorker chowns the worktree but skips .git and dep dirs", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      // Worktree source: a top-level file + a nested file the rebase would touch.
      const topFile = path.join(tmpDir, "package.json");
      const nestedFile = path.join(tmpDir, "src", "App.tsx");
      fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
      fs.writeFileSync(topFile, "{}");
      fs.writeFileSync(nestedFile, "x");
      // `.git` metadata — must be skipped by the worktree walk.
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".git", "index"), "");
      // Dep dirs (top-level + nested) — must be skipped (bounded walk).
      const depFile = path.join(tmpDir, "node_modules", "left-pad", "index.js");
      const nestedDepFile = path.join(tmpDir, "client", "node_modules", "x", "i.js");
      fs.mkdirSync(path.dirname(depFile), { recursive: true });
      fs.mkdirSync(path.dirname(nestedDepFile), { recursive: true });
      fs.writeFileSync(depFile, "");
      fs.writeFileSync(nestedDepFile, "");

      const spy = vi.spyOn(fs, "lchownSync");
      try {
        chownWorktreeToSessionWorker(tmpDir, ["node_modules", "client/node_modules"]);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        // Worktree root + source files: chowned (so the agent can edit + create).
        expect(chowned.has(tmpDir)).toBe(true);
        expect(chowned.has(topFile)).toBe(true);
        expect(chowned.has(nestedFile)).toBe(true);
        // `.git`: never touched here (the .git helper owns it, object-aware).
        expect(chowned.has(path.join(tmpDir, ".git"))).toBe(false);
        expect(chowned.has(path.join(tmpDir, ".git", "index"))).toBe(false);
        // Dep dirs: skipped wholesale — neither the dir nor its contents walked.
        expect(chowned.has(path.join(tmpDir, "node_modules"))).toBe(false);
        expect(chowned.has(depFile)).toBe(false);
        expect(chowned.has(path.join(tmpDir, "client", "node_modules"))).toBe(false);
        expect(chowned.has(nestedDepFile)).toBe(false);
        // The dir leading to a nested dep dir is still chowned (it's source).
        expect(chowned.has(path.join(tmpDir, "client"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("chownWorktreeToSessionWorker is a no-op when the flag is unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const f = path.join(tmpDir, "file.ts");
      fs.writeFileSync(f, "");
      const before = fs.lstatSync(f).uid;
      chownWorktreeToSessionWorker(tmpDir, ["node_modules"]);
      expect(fs.lstatSync(f).uid).toBe(before);
    });

    // planning#147: the session-setup paths (warm-pool create, claim refresh/branch)
    // used to hand back ONLY `.git`, leaving the root-cloned/reset worktree
    // owned root:root and uneditable by the non-root agent. The composite helper
    // hands back BOTH `.git` (object-aware) AND the worktree (minus dep dirs).
    it("handWorkspaceBackToWorker chowns BOTH the worktree and .git, skipping dep dirs", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      // Worktree the root `clone`/`reset --hard` re-materialized.
      const topFile = path.join(tmpDir, "package.json");
      const nestedFile = path.join(tmpDir, "src", "App.tsx");
      fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
      fs.writeFileSync(topFile, "{}");
      fs.writeFileSync(nestedFile, "x");
      // `.git` metadata the root git ops rewrote.
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".git", "index"), "");
      // No shipit.yaml → falls back to DEFAULT_DEP_DIRS (["node_modules"]).
      const depFile = path.join(tmpDir, "node_modules", "left-pad", "index.js");
      fs.mkdirSync(path.dirname(depFile), { recursive: true });
      fs.writeFileSync(depFile, "");

      const spy = vi.spyOn(fs, "lchownSync");
      try {
        handWorkspaceBackToWorker(tmpDir);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        // Worktree handed back (the half that was missing) — this is the fix.
        expect(chowned.has(topFile)).toBe(true);
        expect(chowned.has(nestedFile)).toBe(true);
        // `.git` metadata handed back too (object-aware helper).
        expect(chowned.has(path.join(tmpDir, ".git", "index"))).toBe(true);
        // Dep dir skipped wholesale — bounded walk.
        expect(chowned.has(path.join(tmpDir, "node_modules"))).toBe(false);
        expect(chowned.has(depFile)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("handWorkspaceBackToWorker honors agent.dep-dirs from shipit.yaml", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent:\n  dep-dirs:\n    - vendor\n");
      const vendorFile = path.join(tmpDir, "vendor", "pkg", "x.js");
      const srcFile = path.join(tmpDir, "main.ts");
      fs.mkdirSync(path.dirname(vendorFile), { recursive: true });
      fs.writeFileSync(vendorFile, "");
      fs.writeFileSync(srcFile, "");

      const spy = vi.spyOn(fs, "lchownSync");
      try {
        handWorkspaceBackToWorker(tmpDir);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        expect(chowned.has(srcFile)).toBe(true);
        // The declared dep dir is skipped instead of the default node_modules.
        expect(chowned.has(path.join(tmpDir, "vendor"))).toBe(false);
        expect(chowned.has(vendorFile)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("handWorkspaceBackToWorker is a no-op when the flag is unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const f = path.join(tmpDir, "package.json");
      fs.writeFileSync(f, "{}");
      const before = fs.lstatSync(f).uid;
      const spy = vi.spyOn(fs, "lchownSync");
      try {
        handWorkspaceBackToWorker(tmpDir);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(fs.lstatSync(f).uid).toBe(before);
    });

    it("does not follow symlinks out of the tree", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "swuid-out-"));
      const outsideFile = path.join(outside, "secret");
      fs.writeFileSync(outsideFile, "x");
      try {
        fs.symlinkSync(outside, path.join(tmpDir, "link"));
        // Walk must not traverse into `outside` via the symlink.
        expect(() => chownTreeToSessionWorker(tmpDir)).not.toThrow();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  // #1666 — bounded dep-dir cache reconciliation. Repairs root-owned tool caches
  // (e.g. `node_modules/.vite`) the worktree handback's dep-dir exclusion skips.
  describe("reconcileDepDirCacheOwnership", () => {
    // Build a node_modules with an installed package and a `.vite` cache subtree.
    function seedNodeModules(base: string = tmpDir): { nm: string; pkgFile: string; viteFile: string } {
      const nm = path.join(base, "node_modules");
      const pkgFile = path.join(nm, "left-pad", "index.js");
      const viteFile = path.join(nm, ".vite", "deps", "chunk.js");
      fs.mkdirSync(path.dirname(pkgFile), { recursive: true });
      fs.mkdirSync(path.dirname(viteFile), { recursive: true });
      fs.writeFileSync(pkgFile, "module.exports = 1;");
      fs.writeFileSync(viteFile, "//");
      return { nm, pkgFile, viteFile };
    }

    it("is a no-op when SHIPIT_SESSION_WORKER_UID is unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const { nm } = seedNodeModules();
      const spy = vi.spyOn(fs, "lchownSync");
      try {
        reconcileDepDirCacheOwnership(nm);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("never throws on a missing dep dir (no install yet)", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = String(process.getuid?.() ?? 0);
      const spy = vi.spyOn(fs, "lchownSync");
      try {
        expect(() => reconcileDepDirCacheOwnership(path.join(tmpDir, "node_modules"))).not.toThrow();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    // Common case: everything already worker-owned → a shallow scan that chowns
    // nothing (the steady-state cost is just the direct-child lstats).
    //
    // The reconcile compares the whole (uid, gid) PAIR, and under docs/270 the
    // gid is the shared worker group rather than the session's uid. So "already
    // worker-owned" is stated through the record docs/270 actually reads it
    // from — the owner of the session directory — instead of being inherited
    // from the runner. Deriving it from SHIPIT_SESSION_WORKER_UID alone yields
    // `{uid, gid: uid}`, which matches files the test process created only where
    // getuid() == getgid(); in a ShipIt session container (uid 2000006, gid
    // 1000) every seeded child then reads as a leaked tree and gets chowned.
    it("skips children already owned by the worker uid (zero chowns)", () => {
      const myUid = process.getuid?.();
      const myGid = process.getgid?.();
      if (myUid === undefined || myGid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const sessionsRoot = path.join(tmpDir, "sessions");
      const sessionDir = path.join(sessionsRoot, "sess-1");
      fs.mkdirSync(sessionDir, { recursive: true });
      configureSessionIdentityRoots({ sessionsRoot });
      const { nm } = seedNodeModules(sessionDir);
      const spy = vi.spyOn(fs, "lchownSync");
      try {
        // The premise, asserted rather than assumed: the resolved identity is
        // the pair these files were actually created with.
        expect(identityForTarget(nm)).toEqual({ uid: myUid, gid: myGid });
        reconcileDepDirCacheOwnership(nm);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        configureSessionIdentityRoots(null);
      }
    });

    // Leak case: a direct child not owned by the worker is chowned wholesale,
    // recursing into its subtree (so `.vite/deps/chunk.js` is repaired too).
    it("recursively chowns a direct child not owned by the worker uid", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      // A uid we don't own → every real file lstats as "not worker-owned", so the
      // reconcile treats each direct child as a leaked tree and walks it. The
      // chown itself EPERMs (we lack CAP_CHOWN) and is swallowed; the spy records
      // the attempted paths, proving the bounded recursion.
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid + 1);
      const { nm, pkgFile, viteFile } = seedNodeModules();
      const spy = vi.spyOn(fs, "lchownSync");
      try {
        reconcileDepDirCacheOwnership(nm);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        // Direct children of node_modules are reconciled...
        expect(chowned.has(path.join(nm, ".vite"))).toBe(true);
        expect(chowned.has(path.join(nm, "left-pad"))).toBe(true);
        // ...recursively, so nested cache files are repaired too.
        expect(chowned.has(viteFile)).toBe(true);
        expect(chowned.has(pkgFile)).toBe(true);
        // node_modules itself is NOT chowned — only its children (bounded scan).
        expect(chowned.has(nm)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  /**
   * docs/266 — `.git` must belong to the uid that will run git in it.
   *
   * The production failure this closes:
   * `fatal: could not open '.git/COMMIT_EDITMSG': Permission denied` on the
   * post-turn commit, because the handback answered "who does the container run
   * as" (`SHIPIT_SESSION_WORKER_UID`) while `safeSimpleGit` answered "who owns
   * this tree" (`resolveGitTreeUid`). Two questions, one directory.
   *
   * Tested through the same injection seam `git-tree-uid.test.ts` uses, because
   * the interesting states need root and a foreign-owned tree — neither of which
   * a session container can produce.
   */
  describe("resolveGitDirOwner() — one predicate for both halves", () => {
    /** "We are root, and the tree belongs to `owner`." */
    const asRoot = (owner: { uid: number; gid: number } | null): GitTreeUidDeps => ({
      getuid: () => 0,
      statOwner: () => owner,
    });

    it("follows the DROP, not the variable, when the variable is unset", () => {
      // Disagreement case 1: a root orchestrator over a non-root-owned tree (a
      // host-bind dev setup). `resolveGitTreeUid` never reads the variable, so
      // git dropped while the old handback returned early — leaving any
      // root-owned file inside `.git` unwritable forever, with nothing else in
      // the system to repair it.
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      expect(resolveGitDirOwner(tmpDir, asRoot({ uid: 1000, gid: 1000 })))
        .toEqual({ uid: 1000, gid: 1000 });
    });

    it("follows the DROP when the configured uid disagrees with the tree's owner", () => {
      // Disagreement case 2: a worker-uid migration. An adopted container keeps
      // its old uid, so the tree's owner is not the configured one. The old
      // handback chowned `.git` AWAY from the uid git runs as, on every turn, so
      // the failure could never converge — this is the assertion that pins it.
      process.env.SHIPIT_SESSION_WORKER_UID = "1500";
      expect(resolveGitDirOwner(tmpDir, asRoot({ uid: 1000, gid: 1000 })))
        .toEqual({ uid: 1000, gid: 1000 });
    });

    it("carries the tree's real gid rather than assuming gid = uid", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      expect(resolveGitDirOwner(tmpDir, asRoot({ uid: 1000, gid: 100 })))
        .toEqual({ uid: 1000, gid: 100 });
    });

    it("falls back to the configured uid for a ROOT-OWNED tree — the fresh-clone case", () => {
      // The property that makes this change safe on the session-setup path
      // rather than merely acceptable. `handWorkspaceBackToWorker` runs `.git`
      // FIRST, while a just-cloned workspace is still root-owned; the drop
      // declines there, so the fallback hands `.git` to the configured uid
      // exactly as before and the worktree chown that follows matches it.
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      expect(resolveGitDirOwner(tmpDir, asRoot({ uid: 0, gid: 0 })))
        .toEqual({ uid: 1000, gid: 1000 });
    });

    it("falls back to the configured uid when the process is not root", () => {
      // The session worker, local mode, and every test. Unchanged from before.
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      const notRoot: GitTreeUidDeps = {
        getuid: () => 1000,
        statOwner: () => ({ uid: 1000, gid: 1000 }),
      };
      expect(resolveGitDirOwner(tmpDir, notRoot)).toEqual({ uid: 1000, gid: 1000 });
    });

    it("returns null — a total no-op — when neither half applies", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const notRoot: GitTreeUidDeps = {
        getuid: () => 1000,
        statOwner: () => ({ uid: 1000, gid: 1000 }),
      };
      expect(resolveGitDirOwner(tmpDir, notRoot)).toBeNull();
    });

    it("WIRING: chownWorkspaceGitToSessionWorker chowns to the tree's owner", () => {
      // The predicate tests above would all pass against a
      // `chownWorkspaceGitToSessionWorker` that still called `sessionWorkerUid()`
      // — a correct decision nothing consults is exactly the shape of defect
      // this whole fix is about. So assert the chown ITSELF lands on the tree's
      // owner while the configured uid says something else.
      process.env.SHIPIT_SESSION_WORKER_UID = "1500";
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(gitDir);
      fs.writeFileSync(path.join(gitDir, "COMMIT_EDITMSG"), "msg\n");

      const spy = vi.spyOn(fs, "lchownSync").mockImplementation(() => undefined);
      try {
        chownWorkspaceGitToSessionWorker(tmpDir, {
          getuid: () => 0,
          statOwner: () => ({ uid: 1000, gid: 100 }),
        });
        const editMsg = spy.mock.calls.find(
          (c) => c[0] === path.join(gitDir, "COMMIT_EDITMSG"),
        );
        // The file the production failure named, chowned to the tree's owner
        // (1000:100) and NOT to the configured 1500.
        expect(editMsg).toBeDefined();
        expect(editMsg?.slice(1)).toEqual([1000, 100]);
      } finally {
        spy.mockRestore();
      }
    });

    it("WIRING: the gid reaches the object-store and LFS branches too", () => {
      // `chownGitMetadataRecursive` has three exits — the ordinary node, the
      // shallow `.git/objects` walk, and `chownDirsOnlyRecursive` for
      // `.git/lfs/objects` — and each passes the gid on separately. Asserting it
      // on one metadata file (above) would leave a `uid`-for-`gid` typo on either
      // of the other two green. Threading the real gid is the new behaviour here,
      // so it is checked where it can actually be dropped.
      process.env.SHIPIT_SESSION_WORKER_UID = "1500";
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(path.join(gitDir, "objects", "ab"), { recursive: true });
      fs.mkdirSync(path.join(gitDir, "lfs", "objects", "ab", "cd"), { recursive: true });

      const spy = vi.spyOn(fs, "lchownSync").mockImplementation(() => undefined);
      try {
        chownWorkspaceGitToSessionWorker(tmpDir, {
          getuid: () => 0,
          statOwner: () => ({ uid: 1000, gid: 100 }),
        });
        const at = (p: string) => spy.mock.calls.find((c) => c[0] === p)?.slice(1);
        // The `.git/objects` fanout dir — the shallow-walk branch.
        expect(at(path.join(gitDir, "objects", "ab"))).toEqual([1000, 100]);
        // The LFS two-level fanout — the dirs-only branch.
        expect(at(path.join(gitDir, "lfs", "objects", "ab", "cd"))).toEqual([1000, 100]);
      } finally {
        spy.mockRestore();
      }
    });
  });
});


/**
 * docs/270 — per-session identities.
 *
 * A real uid drop cannot be exercised here (no root, `unshare -r` refused), so
 * these assert what the code SETS and what it RESOLVES, never that another uid
 * was denied. The self-owned cases below are chosen so they run identically
 * privileged or not: chowning to your own uid/gid always succeeds.
 */
describe("per-session identities (docs/270)", () => {
  const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;
  let root: string;
  const selfUid = process.getuid?.() ?? 0;
  const selfGid = process.getgid?.() ?? 0;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "swuid268-"));
  });

  afterEach(() => {
    if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
    configureSessionIdentityRoots(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("sealSessionDir", () => {
    it("sets 0700, which is the whole cross-session boundary", () => {
      // Nothing inside a session needs a restrictive mode of its own: 0700 here
      // denies traversal to every other uid, so no writer downstream has to
      // remember one (req 1).
      const dir = path.join(root, "s1");
      fs.mkdirSync(dir, { mode: 0o755 });

      expect(sealSessionDir(dir, { uid: selfUid, gid: selfGid })).toBe(true);

      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    });

    it("reports failure rather than throwing on a path it cannot seal", () => {
      expect(sealSessionDir(path.join(root, "gone"), { uid: selfUid, gid: selfGid }))
        .toBe(false);
    });
  });

  describe("sealLegacySessionDirs", () => {
    it("does nothing at all when the non-root runtime is off", () => {
      // Local mode and dogfood. A seal here would chown a developer's checkout.
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      fs.mkdirSync(path.join(root, "s1"), { mode: 0o755 });

      expect(sealLegacySessionDirs(root)).toBe(0);
      expect(fs.statSync(path.join(root, "s1")).mode & 0o777).toBe(0o755);
    });

    it("skips a session directory that already carries a record", () => {
      // Re-sealing would be a no-op, and skipping is what keeps the boot pass
      // O(sessions) stats in the steady state. A dir owned by this test's uid
      // stands in for one an earlier boot sealed, or one with an allocated uid.
      process.env.SHIPIT_SESSION_WORKER_UID = String(selfUid);
      const dir = path.join(root, "s1");
      fs.mkdirSync(dir, { mode: 0o755 });
      if (selfUid === 0) return; // running as root: every dir IS root-owned
      expect(sealLegacySessionDirs(root)).toBe(0);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
    });

    it("tolerates a sessions root that does not exist yet", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = String(selfUid);
      expect(sealLegacySessionDirs(path.join(root, "nope"))).toBe(0);
    });

    it("ignores non-directory entries", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = String(selfUid);
      fs.writeFileSync(path.join(root, "stray.txt"), "");
      expect(sealLegacySessionDirs(root)).toBe(0);
    });
  });

  describe("shareTreeWithAllSessions", () => {
    it("adds group read/write to files and group access plus setgid to dirs", () => {
      // The overlay base is the case that makes the MODE load-bearing rather
      // than cosmetic: overlayfs copy-up preserves the lower file's owner AND
      // mode, so a base file at 0644 copies up group-readable and still not
      // editable by the session that copied it.
      process.env.SHIPIT_SESSION_WORKER_UID = String(selfGid);
      const dir = path.join(root, "base");
      fs.mkdirSync(dir, { mode: 0o755 });
      const file = path.join(dir, "dep.js");
      fs.writeFileSync(file, "", { mode: 0o644 });

      shareTreeWithAllSessions(dir);

      expect(fs.statSync(file).mode & 0o777).toBe(0o664);
      expect(fs.statSync(dir).mode & 0o7777).toBe(0o2775);
    });

    it("does nothing when the non-root runtime is off", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const dir = path.join(root, "base");
      fs.mkdirSync(dir, { mode: 0o755 });

      shareTreeWithAllSessions(dir);

      expect(fs.statSync(dir).mode & 0o7777).toBe(0o755);
    });

    it("does not follow a symlink out of the tree", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = String(selfGid);
      const outside = path.join(root, "outside.txt");
      fs.writeFileSync(outside, "", { mode: 0o600 });
      const dir = path.join(root, "base");
      fs.mkdirSync(dir);
      fs.symlinkSync(outside, path.join(dir, "link"));

      shareTreeWithAllSessions(dir);

      // The target keeps its mode — only the link itself was regrouped.
      expect(fs.statSync(outside).mode & 0o777).toBe(0o600);
    });
  });

  describe("sessionWorkerGid / identityForTarget", () => {
    it("falls back to the global value for a path that belongs to no session", () => {
      // The dep cache, the bare cache. Every pre-docs/270 caller keeps working
      // without a signature change because of exactly this.
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      configureSessionIdentityRoots({ sessionsRoot: root });
      expect(identityForTarget("/somewhere/else")).toEqual({ uid: 1000, gid: 1000 });
      expect(sessionWorkerGid()).toBe(1000);
    });

    it("prefers the session's own identity for a path inside it", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      configureSessionIdentityRoots({ sessionsRoot: root });
      const dir = path.join(root, "s1");
      fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
      if (selfUid === 0) return; // a root-owned dir reads as "no record"
      expect(identityForTarget(path.join(dir, "workspace")))
        .toEqual({ uid: selfUid, gid: selfGid });
    });

    it("is null everywhere when the non-root runtime is off", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      expect(identityForTarget("/anything")).toBeNull();
      expect(sessionWorkerGid()).toBeNull();
    });
  });
});
