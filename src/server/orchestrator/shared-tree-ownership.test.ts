import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reclaimSharedTree,
  ensureSharedTreeOwnedByShipIt,
  reclaimSharedTreesUnder,
  type SharedTreeOwnershipDeps,
} from "./shared-tree-ownership.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-shared-tree-"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeCache(dir: string): void {
  fs.mkdirSync(path.join(dir, "refs", "heads", "shipit"), { recursive: true });
  fs.mkdirSync(path.join(dir, "objects", "ab"), { recursive: true });
  fs.mkdirSync(path.join(dir, "objects", "pack"), { recursive: true });
  fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, "refs", "heads", "main"), "0".repeat(40));
  fs.writeFileSync(path.join(dir, "refs", "heads", "shipit", "t9errq"), "1".repeat(40));
  fs.writeFileSync(path.join(dir, "objects", "ab", "cdef"), "object data");
}

// Walk real files, but simulate ownership without requiring root.
function asRoot(over: {
  owners?: (p: string) => { uid: number; gid: number };
  failOn?: (p: string) => boolean;
} = {}): { deps: SharedTreeOwnershipDeps; chowned: string[] } {
  const chowned: string[] = [];
  const deps: SharedTreeOwnershipDeps = {
    getuid: () => 0,
    getgid: () => 0,
    lstat: (p) => {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        return null;
      }
      const owner = over.owners?.(p) ?? { uid: 1000, gid: 1000 };
      return { uid: owner.uid, gid: owner.gid, isDirectory: st.isDirectory() };
    },
    readdir: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return null;
      }
    },
    lchown: (p) => {
      if (over.failOn?.(p)) throw new Error("EPERM");
      chowned.push(p);
    },
  };
  return { deps, chowned };
}

const NOT_ROOT: SharedTreeOwnershipDeps = {
  getuid: () => 1000,
  getgid: () => 1000,
  lstat: () => ({ uid: 1000, gid: 1000, isDirectory: true }),
  readdir: () => [],
  lchown: () => {
    throw new Error("must not be called");
  },
};

describe("reclaimSharedTree", () => {
  it("reclaims every node of a foreign-owned cache, object data files included", () => {
    const cache = path.join(tmpDir, "8e982c4c");
    makeCache(cache);
    const { deps, chowned } = asRoot();

    const result = reclaimSharedTree(cache, deps);

    expect(result.inert).toBe(false);
    expect(result.failed).toBe(0);
    expect(chowned).toContain(path.join(cache, "objects", "ab", "cdef"));
    expect(chowned).toContain(path.join(cache, "refs", "heads", "shipit"));
    expect(result.chowned).toBe(result.visited);
  });

  it("is a no-op cost when the tree is already ShipIt's own", () => {
    const cache = path.join(tmpDir, "root-owned");
    makeCache(cache);
    const { deps, chowned } = asRoot({ owners: () => ({ uid: 0, gid: 0 }) });

    const result = reclaimSharedTree(cache, deps);

    expect(chowned).toEqual([]);
    expect(result.chowned).toBe(0);
    expect(result.visited).toBeGreaterThan(5);
  });

  it("repairs the MIXED tree that produced the production failure", () => {
    const cache = path.join(tmpDir, "mixed");
    makeCache(cache);
    const intruded = path.join(cache, "refs", "heads", "shipit");
    const { deps, chowned } = asRoot({
      owners: (p) => (p.startsWith(intruded) ? { uid: 0, gid: 0 } : { uid: 1000, gid: 1000 }),
    });

    reclaimSharedTree(cache, deps);

    expect(chowned).toContain(cache);
    expect(chowned).toContain(path.join(cache, "refs", "heads", "main"));
    expect(chowned).not.toContain(intruded);
  });

  it("counts a failed chown and keeps going", () => {
    const cache = path.join(tmpDir, "partly-stuck");
    makeCache(cache);
    const stuck = path.join(cache, "HEAD");
    const { deps, chowned } = asRoot({ failOn: (p) => p === stuck });

    const result = reclaimSharedTree(cache, deps);

    expect(result.failed).toBe(1);
    expect(chowned).not.toContain(stuck);
    expect(chowned).toContain(path.join(cache, "objects", "ab", "cdef"));
  });

  it("does nothing at all when the process is not root", () => {
    const result = reclaimSharedTree(path.join(tmpDir, "anything"), NOT_ROOT);
    expect(result.inert).toBe(true);
    expect(result.visited).toBe(0);
  });

  it("re-owns a symlink in place and never follows it out of the tree", () => {
    const cache = path.join(tmpDir, "linked");
    makeCache(cache);
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret"), "not ours to touch");
    fs.symlinkSync(outside, path.join(cache, "escape"));
    const { deps, chowned } = asRoot();

    reclaimSharedTree(cache, deps);

    expect(chowned).toContain(path.join(cache, "escape"));
    expect(chowned).not.toContain(path.join(outside, "secret"));
  });
});

describe("ensureSharedTreeOwnedByShipIt", () => {
  it("costs one lstat when the cache is already ShipIt's own", () => {
    const cache = path.join(tmpDir, "healthy");
    makeCache(cache);
    const { deps, chowned } = asRoot({ owners: () => ({ uid: 0, gid: 0 }) });

    const result = ensureSharedTreeOwnedByShipIt(cache, "test", deps);

    expect(result.visited).toBe(1);
    expect(chowned).toEqual([]);
  });

  it("escalates to a full repair when the TOP LEVEL is foreign", () => {
    const cache = path.join(tmpDir, "foreign");
    makeCache(cache);
    const { deps, chowned } = asRoot();

    const result = ensureSharedTreeOwnedByShipIt(cache, "session clone from bare cache", deps);

    expect(result.chowned).toBeGreaterThan(5);
    expect(chowned).toContain(cache);
  });

  it("says which operation was about to run, and what a foreign owner means", () => {
    const cache = path.join(tmpDir, "loud");
    makeCache(cache);
    const { deps } = asRoot();

    ensureSharedTreeOwnedByShipIt(cache, "bare-cache fetch", deps);

    const said = vi.mocked(console.warn).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(said).toContain("bare-cache fetch");
    expect(said).toContain("1000:1000");
  });

  it("leaves a missing tree alone", () => {
    const { deps, chowned } = asRoot();
    const result = ensureSharedTreeOwnedByShipIt(path.join(tmpDir, "gone"), "test", deps);
    expect(result.chowned).toBe(0);
    expect(chowned).toEqual([]);
  });

  it("does nothing at all when the process is not root", () => {
    expect(ensureSharedTreeOwnedByShipIt(tmpDir, "test", NOT_ROOT).inert).toBe(true);
  });
});

describe("reclaimSharedTreesUnder", () => {
  it("repairs every cache under the root and skips loose files", () => {
    const root = path.join(tmpDir, "repo-cache");
    fs.mkdirSync(root, { recursive: true });
    makeCache(path.join(root, "8e982c4c"));
    makeCache(path.join(root, "4c0c448c"));
    fs.writeFileSync(path.join(root, "stray.txt"), "not a cache");
    const { deps, chowned } = asRoot();

    const result = reclaimSharedTreesUnder(root, "boot ownership pass", deps);

    expect(chowned).toContain(path.join(root, "8e982c4c", "HEAD"));
    expect(chowned).toContain(path.join(root, "4c0c448c", "HEAD"));
    expect(chowned).not.toContain(path.join(root, "stray.txt"));
    expect(result.chowned).toBe(chowned.length);
  });

  it("is a no-op for a root that does not exist yet", () => {
    const { deps } = asRoot();
    expect(reclaimSharedTreesUnder(path.join(tmpDir, "never"), "boot", deps).chowned).toBe(0);
  });
});
