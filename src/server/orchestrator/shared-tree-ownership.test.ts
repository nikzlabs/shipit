/**
 * docs/272-shared-cache-ownership — the repair that makes the shared caches
 * ShipIt's own.
 *
 * These states cannot be produced for real here: a session container has no root
 * and `unshare -r` is refused, so a genuinely foreign-owned directory is not
 * creatable. That is why the module takes `getuid`/`getgid`/`lstat`/`readdir`/
 * `lchown` as injected dependencies — the same seam, and the same reason, as
 * `shared/git-tree-uid.ts`. The walk itself runs over a real temp tree; only the
 * ownership answers are faked.
 */

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

/**
 * A bare cache shaped like the production one: refs the prefetch locks, and an
 * object store whose data files are what `clone --local` hardlinks.
 */
function makeCache(dir: string): void {
  fs.mkdirSync(path.join(dir, "refs", "heads", "shipit"), { recursive: true });
  fs.mkdirSync(path.join(dir, "objects", "ab"), { recursive: true });
  fs.mkdirSync(path.join(dir, "objects", "pack"), { recursive: true });
  fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, "refs", "heads", "main"), "0".repeat(40));
  fs.writeFileSync(path.join(dir, "refs", "heads", "shipit", "t9errq"), "1".repeat(40));
  fs.writeFileSync(path.join(dir, "objects", "ab", "cdef"), "object data");
}

/**
 * Deps for "we are root, and every node reports `owners[path]` (default: uid
 * 1000)". `lchown` is recorded rather than performed — the test cannot really
 * chown, and what matters is which paths it was asked to.
 */
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

/** Not root: the session worker, local mode, the dogfood instance, every test. */
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
    // The object DATA file matters most: it is the hardlink drift planning#417
    // creates, the one thing a top-level stat cannot see, and the reason every
    // OTHER walk in this codebase deliberately skips it. Here the direction is
    // reversed — this IS the shared tree, so restoring it is the repair.
    expect(chowned).toContain(path.join(cache, "objects", "ab", "cdef"));
    // And the ref subdirectory whose root-owned intrusion is what stopped
    // `refs/heads/shipit/<branch>.lock` being created (planning#425).
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
    // Idempotence is what makes running this on every boot safe, so the cost of
    // the steady state is asserted rather than assumed: one lstat per node.
    expect(result.visited).toBeGreaterThan(5);
  });

  it("repairs the MIXED tree that produced the production failure", () => {
    // The exact shape the operator found: a uid-1000 tree root with a root-owned
    // 0755 subdirectory inside it, left by this orchestrator's own prefetch
    // running as root before the docs/266 drop deployed. Neither identity can
    // write all of it, which is why there is no uid to resolve and the tree has
    // to be made uniform instead.
    const cache = path.join(tmpDir, "mixed");
    makeCache(cache);
    const intruded = path.join(cache, "refs", "heads", "shipit");
    const { deps, chowned } = asRoot({
      owners: (p) => (p.startsWith(intruded) ? { uid: 0, gid: 0 } : { uid: 1000, gid: 1000 }),
    });

    reclaimSharedTree(cache, deps);

    expect(chowned).toContain(cache);
    expect(chowned).toContain(path.join(cache, "refs", "heads", "main"));
    // Already ours — not touched, so a mixed tree costs only the drift.
    expect(chowned).not.toContain(intruded);
  });

  it("counts a failed chown and keeps going", () => {
    // Fail-safe is the whole reason this needs no arming flag: the worst outcome
    // of a failed repair is exactly today's behaviour, so a single unreclaimable
    // node must not abandon the rest of the tree.
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
    // docs/272 req 11 — local mode, the dogfood inner instance and every test are
    // byte-for-byte unchanged. `NOT_ROOT.lchown` throws if it is ever reached.
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

    // The hot path: prefetch, claim, warm-pool and plugin fetch all reach this,
    // so the steady-state cost has to be one stat and not a walk.
    expect(result.visited).toBe(1);
    expect(chowned).toEqual([]);
  });

  it("escalates to a full repair when the TOP LEVEL is foreign", () => {
    // One stat is a complete gate for both production failures because both need
    // a foreign top level: the ref-lock EACCES needs `resolveGitTreeUid` to drop
    // (it stats the top level), and `fatal: detected dubious ownership` is git
    // checking the repository ROOT.
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

    // planning#425's complaint was silence, not the failure. Assert the log names
    // the operation and the identities — not its wording.
    const said = vi.mocked(console.warn).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(said).toContain("bare-cache fetch");
    expect(said).toContain("1000:1000");
  });

  it("leaves a missing tree alone", () => {
    // `ensureBareCache` re-clones a vanished cache; a gate that threw here would
    // break that recovery for a directory there is nothing to reason about.
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
    // A deployment that has never cached a repository has nothing to repair, and
    // the boot pass must not treat that as a failure.
    const { deps } = asRoot();
    expect(reclaimSharedTreesUnder(path.join(tmpDir, "never"), "boot", deps).chowned).toBe(0);
  });
});
