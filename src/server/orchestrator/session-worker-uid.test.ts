import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sessionWorkerUid,
  chownToSessionWorker,
  chownTreeToSessionWorker,
  chownWorkspaceGitToSessionWorker,
  chownWorktreeToSessionWorker,
  handWorkspaceBackToWorker,
} from "./session-worker-uid.js";

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

    it("chownWorkspaceGitToSessionWorker is a no-op when the flag is unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(gitDir, { recursive: true });
      const idx = path.join(gitDir, "index");
      fs.writeFileSync(idx, "");
      const before = fs.lstatSync(idx).uid;
      chownWorkspaceGitToSessionWorker(tmpDir);
      expect(fs.lstatSync(idx).uid).toBe(before);
    });

    // SHI-144: the worktree handoff chowns the files the agent edits, skipping
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

    // SHI-145: the session-setup paths (warm-pool create, claim refresh/branch)
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
});
