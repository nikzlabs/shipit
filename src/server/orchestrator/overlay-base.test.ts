import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type OverlayScope,
  type PublishCandidate,
  DEFAULT_DEPTH_CAP,
  copySnapshotToBase,
  publishBase,
  readBasePointer,
  shouldFlattenNext,
} from "./overlay-base.js";
import { overlayBaseDir, overlayScopeHash } from "./overlay-volume.js";

/**
 * Production port of the validated prototype (`run-rolling-base.ts`, 33/33).
 * Ancestry decisions run against a REAL git repo so the
 * `git merge-base --is-ancestor` semantics the CAS relies on are exercised for
 * real, not faked.
 */

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): { dir: string; commit: (msg: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-git-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@shipit.dev");
  git(dir, "config", "user.name", "test");
  let n = 0;
  const commit = (msg: string): string => {
    n++;
    fs.writeFileSync(path.join(dir, `f${n}.txt`), msg);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", msg);
    return git(dir, "rev-parse", "HEAD");
  };
  return { dir, commit };
}

const SCOPE: OverlayScope = {
  repoUrl: "https://github.com/acme/widgets.git",
  runtimeKey: "sha256:img|x64|glibc-2.39|node22",
};

describe("overlay-base: rolling-base publish CAS", () => {
  let tmpDir: string;
  let repoDir: string;
  let commit: (msg: string) => string;
  let stateDir: string;
  let snapshotSeq: number;

  /** A trivial worker-exported merged snapshot: one tagged file per call. */
  function snapshot(tag: string): string {
    const dir = path.join(tmpDir, `snap-${++snapshotSeq}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules.marker"), tag);
    return dir;
  }

  function isAncestor(a: string, b: string): Promise<boolean> {
    try {
      execFileSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", a, b], {
        stdio: "ignore",
      });
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  function candidate(over: Partial<PublishCandidate> & { commit: string }): PublishCandidate {
    return {
      exitCode: 0,
      preUserInstall: true,
      sourceIsDefaultBranch: true,
      snapshotDir: snapshot(over.commit),
      ...over,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-state-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const repo = makeRepo();
    repoDir = repo.dir;
    commit = repo.commit;
    snapshotSeq = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("creates v0 from empty on the first publish", async () => {
    const c1 = commit("c1");
    const res = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c1 }),
      isAncestor,
    });
    expect(res.outcome).toBe("created");
    expect(res.pointer).toMatchObject({ commit: c1, depth: 1, generation: 1 });
    // Base contents were materialized at the scope-hash path.
    const scopeHash = overlayScopeHash(SCOPE.repoUrl, SCOPE.runtimeKey);
    expect(res.pointer?.baseDir).toBe(overlayBaseDir(stateDir, scopeHash));
    expect(fs.existsSync(path.join(res.pointer!.baseDir, "node_modules.marker"))).toBe(true);
  });

  it("advances forward and bumps depth + generation", async () => {
    const c1 = commit("c1");
    await publishBase({ stateDir, scope: SCOPE, candidate: candidate({ commit: c1 }), isAncestor });
    const c2 = commit("c2");
    const res = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c2 }),
      isAncestor,
    });
    expect(res.outcome).toBe("advanced");
    expect(res.pointer).toMatchObject({ commit: c2, depth: 2, generation: 2 });
  });

  it("skips an equal-commit publish (deps already current)", async () => {
    const c1 = commit("c1");
    await publishBase({ stateDir, scope: SCOPE, candidate: candidate({ commit: c1 }), isAncestor });
    const res = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c1 }),
      isAncestor,
    });
    expect(res.outcome).toBe("skipped-equal");
    expect(res.pointer).toMatchObject({ commit: c1, depth: 1 });
  });

  it("declines a behind publish — ordering is ancestry, not wall-clock", async () => {
    const c1 = commit("c1");
    const c2 = commit("c2");
    // Newer base published first.
    await publishBase({ stateDir, scope: SCOPE, candidate: candidate({ commit: c2 }), isAncestor });
    // A late-but-older publisher (still on c1) grabs the lock afterward.
    const res = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c1 }),
      isAncestor,
    });
    expect(res.outcome).toBe("skipped-not-forward");
    expect(res.pointer).toMatchObject({ commit: c2 });
  });

  it("flattens (clean rebuild from empty) at the depth cap", async () => {
    const depthCap = 3;
    let last = "";
    const outcomes: string[] = [];
    for (let i = 0; i < depthCap; i++) {
      last = commit(`c${i}`);
      const res = await publishBase({
        stateDir,
        scope: SCOPE,
        candidate: candidate({ commit: last }),
        isAncestor,
        depthCap,
      });
      outcomes.push(res.outcome);
    }
    // created, advanced (depth 2), then depth would be 3 === cap → flattened.
    expect(outcomes).toEqual(["created", "advanced", "flattened"]);
    const ptr = readBasePointer(stateDir, SCOPE);
    expect(ptr).toMatchObject({ commit: last, depth: 1, generation: 3 });
  });

  /** Rewrite `main` to a divergent orphan line; returns the rewritten commit. */
  function forcePushDivergentHistory(): string {
    git(repoDir, "checkout", "-q", "--orphan", "rewritten");
    fs.writeFileSync(path.join(repoDir, "rewrite.txt"), "rewritten");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", "rewritten");
    return git(repoDir, "rev-parse", "HEAD");
  }

  it("lineage-resets when the candidate is the current default but diverged (force-push)", async () => {
    const c1 = commit("c1");
    await publishBase({ stateDir, scope: SCOPE, candidate: candidate({ commit: c1 }), isAncestor });

    // The new session synced to the (now current default) rewritten commit, which
    // is neither ancestor nor descendant of c1.
    const rewritten = forcePushDivergentHistory();
    const res = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: rewritten }),
      isAncestor,
      currentDefaultCommit: rewritten,
    });
    expect(res.outcome).toBe("reset");
    expect(res.pointer).toMatchObject({ commit: rewritten, depth: 1, generation: 2 });
  });

  it("does NOT reset on a divergence that isn't the current default (stale install, main advanced)", async () => {
    const c1 = commit("c1");
    await publishBase({ stateDir, scope: SCOPE, candidate: candidate({ commit: c1 }), isAncestor });

    // A candidate that diverges from the base but is NOT the current default —
    // e.g. it was built on an older default snapshot while `main` moved on. This
    // must skip, not clobber the healthy base with a reset.
    const diverged = forcePushDivergentHistory();
    const res = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: diverged }),
      isAncestor,
      currentDefaultCommit: "0000000000000000000000000000000000000000", // some other current HEAD
    });
    expect(res.outcome).toBe("skipped-not-forward");
    expect(res.pointer).toMatchObject({ commit: c1, depth: 1, generation: 1 });
  });

  it("skips ineligible candidates (non-zero exit, post-user, or non-default source)", async () => {
    const c1 = commit("c1");
    for (const bad of [
      { commit: c1, exitCode: 1 },
      { commit: c1, preUserInstall: false },
      { commit: c1, sourceIsDefaultBranch: false },
    ]) {
      const res = await publishBase({
        stateDir,
        scope: SCOPE,
        candidate: candidate(bad),
        isAncestor,
      });
      expect(res.outcome).toBe("skipped-ineligible");
    }
    // None of them created a base.
    expect(readBasePointer(stateDir, SCOPE)).toBeNull();
  });

  it("isolates bases by scope (different runtime fingerprint)", async () => {
    const c1 = commit("c1");
    const other: OverlayScope = { ...SCOPE, runtimeKey: "sha256:img|arm64|musl|node22" };
    await publishBase({ stateDir, scope: SCOPE, candidate: candidate({ commit: c1 }), isAncestor });
    await publishBase({ stateDir, scope: other, candidate: candidate({ commit: c1 }), isAncestor });
    expect(readBasePointer(stateDir, SCOPE)?.scopeHash).not.toBe(
      readBasePointer(stateDir, other)?.scopeHash,
    );
    expect(readBasePointer(stateDir, other)).not.toBeNull();
  });

  it("serializes concurrent publishers and converges to the newest commit", async () => {
    const commits = [commit("c1"), commit("c2"), commit("c3"), commit("c4")];
    const newest = commits[commits.length - 1];

    // A materialize that records when it enters/exits, with an await in between,
    // so two overlapping CAS bodies would be detectable (a broken lock would let
    // a second publisher start materializing before the first finished).
    let active = 0;
    let maxConcurrent = 0;
    const materialize = async (snapshotDir: string, scopeHash: string): Promise<string> => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await copySnapshotToBase(stateDir, snapshotDir, scopeHash);
      } finally {
        active--;
      }
    };

    // Fire all publishers concurrently in shuffled order.
    const shuffled = [commits[2], commits[0], commits[3], commits[1]];
    const results = await Promise.all(
      shuffled.map((c) =>
        publishBase({
          stateDir,
          scope: SCOPE,
          candidate: candidate({ commit: c }),
          isAncestor,
          materialize,
        }),
      ),
    );

    // The lock must have kept every CAS body strictly sequential.
    expect(maxConcurrent).toBe(1);
    // Decision is ancestry, not submission order: newest wins regardless.
    expect(readBasePointer(stateDir, SCOPE)?.commit).toBe(newest);
    // Exactly one base was created; behind candidates either advanced (when they
    // arrived in order) or skipped — never a second "created".
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(results.every((r) => r.outcome !== "skipped-ineligible")).toBe(true);
  });

  it("releases the scope lock when a publish throws (next publisher is not wedged)", async () => {
    const c1 = commit("c1");
    let calls = 0;
    const flaky = async (snapshotDir: string, scopeHash: string): Promise<string> => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return copySnapshotToBase(stateDir, snapshotDir, scopeHash);
    };
    await expect(
      publishBase({
        stateDir,
        scope: SCOPE,
        candidate: candidate({ commit: c1 }),
        isAncestor,
        materialize: flaky,
      }),
    ).rejects.toThrow("boom");

    // A second publish for the same scope must still acquire the lock and succeed.
    const res = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c1 }),
      isAncestor,
      materialize: flaky,
    });
    expect(res.outcome).toBe("created");
  });

  it("stamps the top-level base dir mtime on every advance (GC contract)", async () => {
    const c1 = commit("c1");
    const r1 = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c1 }),
      isAncestor,
    });
    const mtime1 = fs.statSync(r1.pointer!.baseDir).mtimeMs;

    await new Promise((r) => setTimeout(r, 10));
    const c2 = commit("c2");
    const r2 = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c2 }),
      isAncestor,
    });
    const mtime2 = fs.statSync(r2.pointer!.baseDir).mtimeMs;
    expect(mtime2).toBeGreaterThan(mtime1);
  });

  it("shouldFlattenNext reports the cap is reached", async () => {
    const depthCap = 2;
    const c1 = commit("c1");
    await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c1 }),
      isAncestor,
      depthCap,
    });
    // depth is 1; next would be 2 === cap.
    expect(shouldFlattenNext(stateDir, SCOPE, depthCap)).toBe(true);
    expect(shouldFlattenNext(stateDir, { ...SCOPE, repoUrl: "other" }, depthCap)).toBe(false);
  });
});

describe("overlay-base: copySnapshotToBase", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-copy-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("atomically swaps fresh contents over the base dir (old contents gone)", async () => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const scopeHash = "deadbeefdeadbeef";

    const snap1 = path.join(tmpDir, "snap1");
    fs.mkdirSync(path.join(snap1, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(snap1, "node_modules", "a.js"), "old");
    fs.writeFileSync(path.join(snap1, "stale.txt"), "remove-me");
    const base1 = await copySnapshotToBase(stateDir, snap1, scopeHash);
    expect(fs.readFileSync(path.join(base1, "stale.txt"), "utf8")).toBe("remove-me");

    const snap2 = path.join(tmpDir, "snap2");
    fs.mkdirSync(path.join(snap2, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(snap2, "node_modules", "a.js"), "new");
    const base2 = await copySnapshotToBase(stateDir, snap2, scopeHash);

    expect(base2).toBe(base1); // same scope-hash path
    expect(fs.readFileSync(path.join(base2, "node_modules", "a.js"), "utf8")).toBe("new");
    // The stale file from snap1 is gone — a clean swap, not a merge.
    expect(fs.existsSync(path.join(base2, "stale.txt"))).toBe(false);
    // No leftover temp dirs under overlay-base/.
    const entries = fs.readdirSync(path.join(stateDir, "overlay-base"));
    expect(entries.filter((e) => e.startsWith(".tmp-"))).toEqual([]);
  });

  it("preserves symlinks rather than dereferencing them", async () => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const snap = path.join(tmpDir, "snap");
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "real.js"), "x");
    fs.symlinkSync("real.js", path.join(snap, "link.js"));
    const base = await copySnapshotToBase(stateDir, snap, "cafebabecafebabe");
    expect(fs.lstatSync(path.join(base, "link.js")).isSymbolicLink()).toBe(true);
  });
});

it("DEFAULT_DEPTH_CAP is well below the overlay hard limit", () => {
  expect(DEFAULT_DEPTH_CAP).toBeGreaterThanOrEqual(8);
  expect(DEFAULT_DEPTH_CAP).toBeLessThan(128);
});
