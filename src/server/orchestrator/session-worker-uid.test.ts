import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyDefaultGroupAcl,
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

    it("recursively chowns a subtree to the configured uid", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
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
      if (myUid === undefined) return;
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
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const gitDir = path.join(tmpDir, ".git");
      const looseObj = path.join(gitDir, "objects", "ab", "cdef0123");
      const packFile = path.join(gitDir, "objects", "pack", "pack-x.pack");
      fs.mkdirSync(path.dirname(looseObj), { recursive: true });
      fs.mkdirSync(path.dirname(packFile), { recursive: true });
      fs.writeFileSync(looseObj, "obj");
      fs.writeFileSync(packFile, "pack");
      fs.mkdirSync(path.join(gitDir, "logs"), { recursive: true });
      fs.writeFileSync(path.join(gitDir, "logs", "HEAD"), "");
      fs.writeFileSync(path.join(gitDir, "index"), "");

      const spy = vi.spyOn(fs, "lchownSync");
      try {
        chownWorkspaceGitToSessionWorker(tmpDir);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        expect(chowned.has(looseObj)).toBe(false);
        expect(chowned.has(packFile)).toBe(false);
        expect(chowned.has(path.join(gitDir, "objects"))).toBe(true);
        expect(chowned.has(path.join(gitDir, "objects", "ab"))).toBe(true);
        expect(chowned.has(path.join(gitDir, "objects", "pack"))).toBe(true);
        expect(chowned.has(path.join(gitDir, "index"))).toBe(true);
        expect(chowned.has(path.join(gitDir, "logs", "HEAD"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("chownWorkspaceGitToSessionWorker skips LFS object files but chowns their fanout dirs", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const gitDir = path.join(tmpDir, ".git");
      const lfsObjects = path.join(gitDir, "lfs", "objects");
      const lfsObj = path.join(lfsObjects, "ab", "cd", "abcdef0123");
      fs.mkdirSync(path.dirname(lfsObj), { recursive: true });
      fs.writeFileSync(lfsObj, "asset-bytes");
      fs.writeFileSync(path.join(gitDir, "lfs", "cache-meta"), "");

      const spy = vi.spyOn(fs, "lchownSync");
      try {
        chownWorkspaceGitToSessionWorker(tmpDir);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        expect(chowned.has(lfsObj)).toBe(false);
        expect(chowned.has(lfsObjects)).toBe(true);
        expect(chowned.has(path.join(lfsObjects, "ab"))).toBe(true);
        expect(chowned.has(path.join(lfsObjects, "ab", "cd"))).toBe(true);
        expect(chowned.has(path.join(gitDir, "lfs", "cache-meta"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("chownWorkspaceGitToSessionWorker leaves a hardlinked LFS object owned as-is", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
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

    it("chownWorktreeToSessionWorker chowns the worktree but skips .git and dep dirs", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const topFile = path.join(tmpDir, "package.json");
      const nestedFile = path.join(tmpDir, "src", "App.tsx");
      fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
      fs.writeFileSync(topFile, "{}");
      fs.writeFileSync(nestedFile, "x");
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".git", "index"), "");
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
        expect(chowned.has(tmpDir)).toBe(true);
        expect(chowned.has(topFile)).toBe(true);
        expect(chowned.has(nestedFile)).toBe(true);
        expect(chowned.has(path.join(tmpDir, ".git"))).toBe(false);
        expect(chowned.has(path.join(tmpDir, ".git", "index"))).toBe(false);
        expect(chowned.has(path.join(tmpDir, "node_modules"))).toBe(false);
        expect(chowned.has(depFile)).toBe(false);
        expect(chowned.has(path.join(tmpDir, "client", "node_modules"))).toBe(false);
        expect(chowned.has(nestedDepFile)).toBe(false);
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

    it("handWorkspaceBackToWorker chowns BOTH the worktree and .git, skipping dep dirs", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const topFile = path.join(tmpDir, "package.json");
      const nestedFile = path.join(tmpDir, "src", "App.tsx");
      fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
      fs.writeFileSync(topFile, "{}");
      fs.writeFileSync(nestedFile, "x");
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".git", "index"), "");
      const depFile = path.join(tmpDir, "node_modules", "left-pad", "index.js");
      fs.mkdirSync(path.dirname(depFile), { recursive: true });
      fs.writeFileSync(depFile, "");

      const spy = vi.spyOn(fs, "lchownSync");
      try {
        handWorkspaceBackToWorker(tmpDir);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        expect(chowned.has(topFile)).toBe(true);
        expect(chowned.has(nestedFile)).toBe(true);
        expect(chowned.has(path.join(tmpDir, ".git", "index"))).toBe(true);
        expect(chowned.has(path.join(tmpDir, "node_modules"))).toBe(false);
        expect(chowned.has(depFile)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("handWorkspaceBackToWorker leaves the worktree group-writable for compose services", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const topFile = path.join(tmpDir, "vite.config.ts");
      const nestedFile = path.join(tmpDir, "src", "App.tsx");
      fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
      fs.writeFileSync(topFile, "{}");
      fs.writeFileSync(nestedFile, "x");
      fs.chmodSync(tmpDir, 0o755);
      fs.chmodSync(topFile, 0o644);
      fs.chmodSync(path.dirname(nestedFile), 0o755);
      fs.chmodSync(nestedFile, 0o644);

      handWorkspaceBackToWorker(tmpDir);

      const mode = (p: string) => fs.lstatSync(p).mode & 0o7777;
      expect(mode(topFile)).toBe(0o664);
      expect(mode(nestedFile)).toBe(0o664);
      expect(mode(tmpDir)).toBe(0o2775);
      expect(mode(path.dirname(nestedFile))).toBe(0o2775);
    });

    it("group-write does not make a non-executable file executable", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const script = path.join(tmpDir, "build.sh");
      const plain = path.join(tmpDir, "README.md");
      fs.writeFileSync(script, "");
      fs.writeFileSync(plain, "");
      fs.chmodSync(script, 0o755);
      fs.chmodSync(plain, 0o600);

      handWorkspaceBackToWorker(tmpDir);

      const mode = (p: string) => fs.lstatSync(p).mode & 0o7777;
      expect(mode(script)).toBe(0o775);
      expect(mode(plain)).toBe(0o660);
    });

    it("handWorkspaceBackToWorker honors agent.dep-dirs from shipit.yaml", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
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
        expect(() => chownTreeToSessionWorker(tmpDir)).not.toThrow();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("reconcileDepDirCacheOwnership", () => {
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

    it("makes the dep dir root group-writable, so a service can create a cache in it", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const { nm } = seedNodeModules();
      fs.chmodSync(nm, 0o755);

      reconcileDepDirCacheOwnership(nm);

      expect(fs.lstatSync(nm).mode & 0o7777).toBe(0o2775);
    });

    it("group-writes a leaked cache tree it takes ownership of", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const { nm, viteFile } = seedNodeModules();
      const viteDir = path.join(nm, ".vite");
      fs.chmodSync(viteDir, 0o755);
      fs.chmodSync(viteFile, 0o644);
      // Change the expected owner to exercise repair without CAP_CHOWN.
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid + 1);

      reconcileDepDirCacheOwnership(nm);

      const mode = (p: string) => fs.lstatSync(p).mode & 0o7777;
      expect(mode(viteDir)).toBe(0o2775);
      expect(mode(viteFile)).toBe(0o664);
    });

    it("refuses to walk a symlinked dep dir at all", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const outside = path.join(tmpDir, "outside");
      const victim = path.join(outside, "pkg", "index.js");
      fs.mkdirSync(path.dirname(victim), { recursive: true });
      fs.writeFileSync(victim, "");
      fs.chmodSync(path.dirname(victim), 0o755);
      fs.chmodSync(victim, 0o644);
      const link = path.join(tmpDir, "node_modules");
      fs.symlinkSync(outside, link);

      reconcileDepDirCacheOwnership(link);

      expect(fs.lstatSync(path.dirname(victim)).mode & 0o7777).toBe(0o755);
      expect(fs.lstatSync(victim).mode & 0o7777).toBe(0o644);
    });

    // Resolve ownership from the directory: this test process's UID and GID can differ.
    it("skips children already owned by the worker uid (zero chowns)", () => {
      const myUid = process.getuid?.();
      const myGid = process.getgid?.();
      if (myUid === undefined || myGid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const sessionsRoot = path.join(tmpDir, "sessions");
      const sessionDir = path.join(sessionsRoot, "sess-1");
      fs.mkdirSync(sessionDir, { recursive: true });
      configureSessionIdentityRoots({ sessionsRoot });
      const { nm } = seedNodeModules(sessionDir);
      const spy = vi.spyOn(fs, "lchownSync");
      try {
        expect(identityForTarget(nm)).toEqual({ uid: myUid, gid: myGid });
        reconcileDepDirCacheOwnership(nm);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        configureSessionIdentityRoots(null);
      }
    });

    it("recursively chowns a direct child not owned by the worker uid", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      // Observe attempted chowns; changing ownership needs CAP_CHOWN.
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid + 1);
      const { nm, pkgFile, viteFile } = seedNodeModules();
      const spy = vi.spyOn(fs, "lchownSync");
      try {
        reconcileDepDirCacheOwnership(nm);
        const chowned = new Set(spy.mock.calls.map((c) => c[0] as string));
        expect(chowned.has(path.join(nm, ".vite"))).toBe(true);
        expect(chowned.has(path.join(nm, "left-pad"))).toBe(true);
        expect(chowned.has(viteFile)).toBe(true);
        expect(chowned.has(pkgFile)).toBe(true);
        expect(chowned.has(nm)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("resolveGitDirOwner() — one predicate for both halves", () => {
    const asRoot = (owner: { uid: number; gid: number } | null): GitTreeUidDeps => ({
      getuid: () => 0,
      statOwner: () => owner,
    });

    it("follows the DROP, not the variable, when the variable is unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      expect(resolveGitDirOwner(tmpDir, asRoot({ uid: 1000, gid: 1000 })))
        .toEqual({ uid: 1000, gid: 1000 });
    });

    it("follows the DROP when the configured uid disagrees with the tree's owner", () => {
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
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      expect(resolveGitDirOwner(tmpDir, asRoot({ uid: 0, gid: 0 })))
        .toEqual({ uid: 1000, gid: 1000 });
    });

    it("falls back to the configured uid when the process is not root", () => {
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
        expect(editMsg).toBeDefined();
        expect(editMsg?.slice(1)).toEqual([1000, 100]);
      } finally {
        spy.mockRestore();
      }
    });

    it("WIRING: the gid reaches the object-store and LFS branches too", () => {
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
        expect(at(path.join(gitDir, "objects", "ab"))).toEqual([1000, 100]);
        expect(at(path.join(gitDir, "lfs", "objects", "ab", "cd"))).toEqual([1000, 100]);
      } finally {
        spy.mockRestore();
      }
    });
  });
});


// These check ownership and mode, not access denial from another UID.
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
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      fs.mkdirSync(path.join(root, "s1"), { mode: 0o755 });

      expect(sealLegacySessionDirs(root)).toBe(0);
      expect(fs.statSync(path.join(root, "s1")).mode & 0o777).toBe(0o755);
    });

    it("skips a session directory that already carries a record", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = String(selfUid);
      const dir = path.join(root, "s1");
      fs.mkdirSync(dir, { mode: 0o755 });
      if (selfUid === 0) return;
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

      expect(fs.statSync(outside).mode & 0o777).toBe(0o600);
    });
  });

  describe("sessionWorkerGid / identityForTarget", () => {
    it("falls back to the global value for a path that belongs to no session", () => {
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
      if (selfUid === 0) return;
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

const HAS_SETFACL = (() => {
  try {
    execFileSync("setfacl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("default group ACLs on the worktree (docs/271 §3)", () => {
  const prev = process.env.SHIPIT_SESSION_WORKER_UID;
  const prevPath = process.env.PATH;
  let tmpDir: string;
  let binDir: string;
  let log: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swacl-"));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "swaclbin-"));
    log = path.join(binDir, "setfacl.log");
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = prev;
    process.env.PATH = prevPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function stubSetfacl(): void {
    fs.writeFileSync(
      path.join(binDir, "setfacl"),
      `#!/bin/sh\necho CALL >> "${log}"\nprintf '%s\\n' "$@" >> "${log}"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;
  }

  function invocations(): string[][] {
    if (!fs.existsSync(log)) return [];
    return fs.readFileSync(log, "utf8")
      .split("CALL\n").slice(1)
      .map((call) => call.split("\n").filter(Boolean));
  }

  it("gives every worktree directory a default group ACL, and nothing else one", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
    stubSetfacl();

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "App.tsx"), "x");
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.mkdirSync(path.join(tmpDir, ".git", "objects", "4d"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "node_modules", "left-pad"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "client", "node_modules", "x"), { recursive: true });

    chownWorktreeToSessionWorker(tmpDir, ["node_modules", "client/node_modules"]);

    const calls = invocations();
    expect(calls).toHaveLength(1);
    const [flags, paths] = [calls[0].slice(0, 4), calls[0].slice(4)];
    expect(flags).toEqual(["-d", "-m", "g::rwx", "--"]);
    expect([...paths].sort()).toEqual([
      tmpDir,
      path.join(tmpDir, "client"),
      path.join(tmpDir, "src"),
    ].sort());
    expect(paths).not.toContain(path.join(tmpDir, "package.json"));
    expect(paths).not.toContain(path.join(tmpDir, "src", "App.tsx"));
  });

  it("batches rather than spawning once per directory", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
    stubSetfacl();

    const made: string[] = [];
    for (let i = 0; i < 300; i++) {
      const d = path.join(tmpDir, `d${i}`);
      fs.mkdirSync(d);
      made.push(d);
    }

    chownWorktreeToSessionWorker(tmpDir, []);

    const calls = invocations();
    expect(calls).toHaveLength(2);
    const seen = calls.flatMap((c) => c.slice(4));
    expect(seen).toHaveLength(301);
    for (const d of made) expect(seen).toContain(d);
  });

  it("still hands the tree over when setfacl is missing", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
    process.env.PATH = binDir;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(tmpDir, "src"));
      fs.chmodSync(path.join(tmpDir, "src"), 0o755);

      expect(() => chownWorktreeToSessionWorker(tmpDir, [])).not.toThrow();

      expect(fs.statSync(path.join(tmpDir, "src")).mode & 0o7777).toBe(0o2775);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps going after a refused batch, so one vanished path costs only itself", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const calls: string[][] = [];
      applyDefaultGroupAcl(
        Array.from({ length: 600 }, (_, i) => `/w/d${i}`),
        (dirs) => {
          calls.push([...dirs]);
          if (calls.length === 1) throw new Error("No such file or directory");
        },
      );
      expect(calls).toHaveLength(3);
      expect(calls.flat()).toHaveLength(600);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain("256 of 600");
    } finally {
      warn.mockRestore();
    }
  });

  it("stops at the first batch when the tool itself is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const calls: string[][] = [];
      applyDefaultGroupAcl(
        Array.from({ length: 600 }, (_, i) => `/w/d${i}`),
        (dirs) => {
          calls.push([...dirs]);
          throw Object.assign(new Error("spawnSync setfacl ENOENT"), { code: "ENOENT" });
        },
      );
      expect(calls).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it.skipIf(!HAS_SETFACL)("makes a umask-022 writer create group-writable nodes", () => {
    const myUid = process.getuid?.();
    if (myUid === undefined) return;
    process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);

    fs.mkdirSync(path.join(tmpDir, "assets"));
    chownWorktreeToSessionWorker(tmpDir, []);

    const before = process.umask(0o022);
    try {
      fs.mkdirSync(path.join(tmpDir, "assets", ".cache"));
      fs.writeFileSync(path.join(tmpDir, "assets", ".cache", "x.webp"), "");
    } finally {
      process.umask(before);
    }

    expect(fs.statSync(path.join(tmpDir, "assets", ".cache")).mode & 0o070).toBe(0o070);
    expect(fs.statSync(path.join(tmpDir, "assets", ".cache", "x.webp")).mode & 0o060).toBe(0o060);
  });
});
