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
import { overlayBaseDir, overlayBaseGenDir, overlayScopeHash } from "./overlay-volume.js";

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
    // Base contents were materialized as generation 1 under the scope-hash dir.
    const scopeHash = overlayScopeHash(SCOPE.repoUrl, SCOPE.runtimeKey);
    expect(res.pointer?.baseDir).toBe(overlayBaseGenDir(stateDir, scopeHash, 1));
    expect(fs.existsSync(path.join(res.pointer!.baseDir, "node_modules.marker"))).toBe(true);
  });

  // SHI-145 — the materialized base is handed to the worker uid so overlayfs
  // copy-up of an existing base dep stays writable for the non-root agent. The
  // chown itself needs privileges, so we inject a spy and assert it fires on the
  // freshly-materialized generation (and only after a real materialize).
  it("hands each materialized base generation to the worker uid (created + advanced)", async () => {
    const chowned: string[] = [];
    const chownBaseDir = (dir: string): void => {
      chowned.push(dir);
    };
    const scopeHash = overlayScopeHash(SCOPE.repoUrl, SCOPE.runtimeKey);

    const c1 = commit("c1");
    const r1 = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c1 }),
      isAncestor,
      chownBaseDir,
    });
    expect(r1.outcome).toBe("created");
    expect(chowned).toEqual([overlayBaseGenDir(stateDir, scopeHash, 1)]);

    const c2 = commit("c2");
    const r2 = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c2 }),
      isAncestor,
      chownBaseDir,
    });
    expect(r2.outcome).toBe("advanced");
    // The new generation is chowned; the chown is invoked exactly once per publish.
    expect(chowned).toEqual([
      overlayBaseGenDir(stateDir, scopeHash, 1),
      overlayBaseGenDir(stateDir, scopeHash, 2),
    ]);
  });

  it("does not chown when a publish is skipped (no materialize, no handoff)", async () => {
    const chowned: string[] = [];
    const chownBaseDir = (dir: string): void => {
      chowned.push(dir);
    };
    const c1 = commit("c1");
    await publishBase({ stateDir, scope: SCOPE, candidate: candidate({ commit: c1 }), isAncestor, chownBaseDir });
    chowned.length = 0;
    // Equal-commit republish → skipped-equal, nothing materialized.
    const res = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c1 }),
      isAncestor,
      chownBaseDir,
    });
    expect(res.outcome).toBe("skipped-equal");
    expect(chowned).toEqual([]);
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

  it("an advance leaves the previous generation untouched (immutable lowerdirs, no tmp leaks)", async () => {
    // docs/183 — bases are immutable generations: live overlay mounts pin a
    // specific g<N> as their lowerdir, and (spike-proven) renaming/deleting a
    // mounted lowerdir breaks merged-readdir for every same-scope session. So an
    // advance must create g2 BESIDE g1 — never mutate, rename, or remove g1 —
    // and move only the pointer. Stale generations are the disk-janitor's job.
    const scopeHash = overlayScopeHash(SCOPE.repoUrl, SCOPE.runtimeKey);

    const c1 = commit("c1");
    const r1 = await publishBase({ stateDir, scope: SCOPE, candidate: candidate({ commit: c1 }), isAncestor });
    expect(r1.pointer?.baseDir).toBe(overlayBaseGenDir(stateDir, scopeHash, 1));
    expect(fs.readFileSync(path.join(r1.pointer!.baseDir, "node_modules.marker"), "utf8")).toBe(c1);

    const c2 = commit("c2");
    const r2 = await publishBase({ stateDir, scope: SCOPE, candidate: candidate({ commit: c2 }), isAncestor });
    expect(r2.pointer?.baseDir).toBe(overlayBaseGenDir(stateDir, scopeHash, 2));
    expect(fs.readFileSync(path.join(r2.pointer!.baseDir, "node_modules.marker"), "utf8")).toBe(c2);

    // g1 is still exactly what it was — a live mount may be pinning it.
    expect(fs.readFileSync(path.join(overlayBaseGenDir(stateDir, scopeHash, 1), "node_modules.marker"), "utf8")).toBe(c1);

    // No `.tmp-*` copies leak in the scope dir (unreferenced disk the GC can't key on).
    const leaked = fs.readdirSync(overlayBaseDir(stateDir, scopeHash)).filter((n) => n.startsWith(".tmp-"));
    expect(leaked).toEqual([]);
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
    const materialize = async (snapshotDir: string, scopeHash: string, generation: number): Promise<string> => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await copySnapshotToBase(stateDir, snapshotDir, scopeHash, generation);
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
    const flaky = async (snapshotDir: string, scopeHash: string, generation: number): Promise<string> => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return copySnapshotToBase(stateDir, snapshotDir, scopeHash, generation);
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

  it("stamps the top-level scope dir mtime on every advance (GC contract)", async () => {
    const scopeDir = overlayBaseDir(stateDir, overlayScopeHash(SCOPE.repoUrl, SCOPE.runtimeKey));
    const c1 = commit("c1");
    await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c1 }),
      isAncestor,
    });
    const mtime1 = fs.statSync(scopeDir).mtimeMs;

    await new Promise((r) => setTimeout(r, 10));
    const c2 = commit("c2");
    await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate({ commit: c2 }),
      isAncestor,
    });
    const mtime2 = fs.statSync(scopeDir).mtimeMs;
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

  it("materializes each generation at its own immutable path (no cross-generation mutation)", async () => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const scopeHash = "deadbeefdeadbeef";

    const snap1 = path.join(tmpDir, "snap1");
    fs.mkdirSync(path.join(snap1, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(snap1, "node_modules", "a.js"), "old");
    const base1 = await copySnapshotToBase(stateDir, snap1, scopeHash, 1);
    expect(base1).toBe(overlayBaseGenDir(stateDir, scopeHash, 1));

    const snap2 = path.join(tmpDir, "snap2");
    fs.mkdirSync(path.join(snap2, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(snap2, "node_modules", "a.js"), "new");
    const base2 = await copySnapshotToBase(stateDir, snap2, scopeHash, 2);

    expect(base2).toBe(overlayBaseGenDir(stateDir, scopeHash, 2));
    expect(fs.readFileSync(path.join(base2, "node_modules", "a.js"), "utf8")).toBe("new");
    // Generation 1 is untouched — a live mount may pin it as lowerdir.
    expect(fs.readFileSync(path.join(base1, "node_modules", "a.js"), "utf8")).toBe("old");
    // No leftover temp dirs in the scope dir.
    const entries = fs.readdirSync(overlayBaseDir(stateDir, scopeHash));
    expect(entries.filter((e) => e.startsWith(".tmp-"))).toEqual([]);
  });

  it("rebuilds a crash-orphaned generation dir (rename landed, pointer write didn't)", async () => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const scopeHash = "deadbeefdeadbeef";
    // Simulate the orphan: g3 exists with stale content but no pointer named it.
    const orphan = overlayBaseGenDir(stateDir, scopeHash, 3);
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "stale.txt"), "leftover");

    const snap = path.join(tmpDir, "snap");
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "fresh.txt"), "fresh");
    const base = await copySnapshotToBase(stateDir, snap, scopeHash, 3);
    expect(fs.readFileSync(path.join(base, "fresh.txt"), "utf8")).toBe("fresh");
    expect(fs.existsSync(path.join(base, "stale.txt"))).toBe(false);
  });

  it("preserves symlinks rather than dereferencing them", async () => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const snap = path.join(tmpDir, "snap");
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "real.js"), "x");
    fs.symlinkSync("real.js", path.join(snap, "link.js"));
    const base = await copySnapshotToBase(stateDir, snap, "cafebabecafebabe", 1);
    expect(fs.lstatSync(path.join(base, "link.js")).isSymbolicLink()).toBe(true);
  });
});

describe("overlay-base: hardlink-dedup materialize (docs/183 generation dedup)", () => {
  let tmpDir: string;
  let stateDir: string;
  const scopeHash = "feedfacefeedface";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-dedup-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function snap(name: string, files: Record<string, string>): string {
    const dir = path.join(tmpDir, name);
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return dir;
  }

  function ino(p: string): number {
    return fs.lstatSync(p).ino;
  }

  it("hardlinks unchanged files to the previous generation and copies changed ones", async () => {
    const g1 = await copySnapshotToBase(
      stateDir,
      snap("s1", { "node_modules/lib/index.js": "unchanged", "node_modules/lib/v.js": "1.0.0" }),
      scopeHash,
      1,
    );
    const g2 = await copySnapshotToBase(
      stateDir,
      snap("s2", { "node_modules/lib/index.js": "unchanged", "node_modules/lib/v.js": "2.0.0" }),
      scopeHash,
      2,
      g1,
    );
    // Identical content → shared inode; changed content → its own inode.
    expect(ino(path.join(g2, "node_modules/lib/index.js"))).toBe(
      ino(path.join(g1, "node_modules/lib/index.js")),
    );
    expect(ino(path.join(g2, "node_modules/lib/v.js"))).not.toBe(
      ino(path.join(g1, "node_modules/lib/v.js")),
    );
    expect(fs.readFileSync(path.join(g2, "node_modules/lib/v.js"), "utf8")).toBe("2.0.0");
    // g1 untouched — a live mount may pin it.
    expect(fs.readFileSync(path.join(g1, "node_modules/lib/v.js"), "utf8")).toBe("1.0.0");
  });

  it("does NOT link a same-size, same-mtime file whose content changed (npm's constant mtimes)", async () => {
    const s1 = snap("s1", { "node_modules/x.js": "AAAA" });
    const s2 = snap("s2", { "node_modules/x.js": "BBBB" });
    // npm normalizes package mtimes to a fixed epoch — reproduce that worst case
    // so a size+mtime heuristic would wrongly call these "unchanged".
    const epoch = new Date("1985-10-26T08:15:00Z");
    fs.utimesSync(path.join(s1, "node_modules/x.js"), epoch, epoch);
    fs.utimesSync(path.join(s2, "node_modules/x.js"), epoch, epoch);

    const g1 = await copySnapshotToBase(stateDir, s1, scopeHash, 1);
    const g2 = await copySnapshotToBase(stateDir, s2, scopeHash, 2, g1);
    expect(fs.readFileSync(path.join(g2, "node_modules/x.js"), "utf8")).toBe("BBBB");
    expect(ino(path.join(g2, "node_modules/x.js"))).not.toBe(ino(path.join(g1, "node_modules/x.js")));
  });

  it("handles added and removed paths (no stale carry-over from the link base)", async () => {
    const g1 = await copySnapshotToBase(
      stateDir,
      snap("s1", { "node_modules/old-dep/index.js": "x", "node_modules/keep.js": "k" }),
      scopeHash,
      1,
    );
    const g2 = await copySnapshotToBase(
      stateDir,
      snap("s2", { "node_modules/new-dep/index.js": "y", "node_modules/keep.js": "k" }),
      scopeHash,
      2,
      g1,
    );
    expect(fs.existsSync(path.join(g2, "node_modules/old-dep"))).toBe(false);
    expect(fs.readFileSync(path.join(g2, "node_modules/new-dep/index.js"), "utf8")).toBe("y");
    expect(ino(path.join(g2, "node_modules/keep.js"))).toBe(ino(path.join(g1, "node_modules/keep.js")));
  });

  it("recreates symlinks verbatim instead of hardlinking them", async () => {
    const s1 = snap("s1", { "node_modules/.bin-real.js": "bin" });
    fs.symlinkSync(".bin-real.js", path.join(s1, "node_modules", "alias.js"));
    const g1 = await copySnapshotToBase(stateDir, s1, scopeHash, 1);

    const s2 = snap("s2", { "node_modules/.bin-real.js": "bin" });
    fs.symlinkSync(".bin-real.js", path.join(s2, "node_modules", "alias.js"));
    const g2 = await copySnapshotToBase(stateDir, s2, scopeHash, 2, g1);

    const l = path.join(g2, "node_modules", "alias.js");
    expect(fs.lstatSync(l).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(l)).toBe(".bin-real.js");
  });

  it("does not link files whose modes differ even with identical content", async () => {
    const s1 = snap("s1", { "node_modules/run.sh": "#!/bin/sh" });
    fs.chmodSync(path.join(s1, "node_modules/run.sh"), 0o755);
    const g1 = await copySnapshotToBase(stateDir, s1, scopeHash, 1);

    const s2 = snap("s2", { "node_modules/run.sh": "#!/bin/sh" });
    fs.chmodSync(path.join(s2, "node_modules/run.sh"), 0o644);
    const g2 = await copySnapshotToBase(stateDir, s2, scopeHash, 2, g1);

    expect(ino(path.join(g2, "node_modules/run.sh"))).not.toBe(ino(path.join(g1, "node_modules/run.sh")));
    expect(fs.lstatSync(path.join(g2, "node_modules/run.sh")).mode & 0o777).toBe(0o644);
  });

  it("falls back to a plain copy when the link base is missing", async () => {
    const g2 = await copySnapshotToBase(
      stateDir,
      snap("s1", { "node_modules/a.js": "a" }),
      scopeHash,
      2,
      path.join(tmpDir, "no-such-generation"),
    );
    expect(fs.readFileSync(path.join(g2, "node_modules/a.js"), "utf8")).toBe("a");
  });

  it("publishBase advance dedups against the superseded generation end-to-end", async () => {
    const { dir: repoDir, commit } = makeRepo();
    const isAncestor = async (anc: string, desc: string): Promise<boolean> => {
      try {
        execFileSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", anc, desc]);
        return true;
      } catch {
        return false;
      }
    };
    const candidate = (commitSha: string, dir: string): PublishCandidate => ({
      commit: commitSha,
      exitCode: 0,
      preUserInstall: true,
      sourceIsDefaultBranch: true,
      snapshotDir: dir,
    });

    const c1 = commit("one");
    const r1 = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate(c1, snap("p1", { "node_modules/same.js": "S", "node_modules/v.js": "1" })),
      isAncestor,
    });
    expect(r1.outcome).toBe("created");

    const c2 = commit("two");
    const r2 = await publishBase({
      stateDir,
      scope: SCOPE,
      candidate: candidate(c2, snap("p2", { "node_modules/same.js": "S", "node_modules/v.js": "2" })),
      isAncestor,
    });
    expect(r2.outcome).toBe("advanced");
    const g1 = r1.pointer!.baseDir;
    const g2 = r2.pointer!.baseDir;
    expect(ino(path.join(g2, "node_modules/same.js"))).toBe(ino(path.join(g1, "node_modules/same.js")));
    expect(ino(path.join(g2, "node_modules/v.js"))).not.toBe(ino(path.join(g1, "node_modules/v.js")));
  });
});

it("DEFAULT_DEPTH_CAP is well below the overlay hard limit", () => {
  expect(DEFAULT_DEPTH_CAP).toBeGreaterThanOrEqual(8);
  expect(DEFAULT_DEPTH_CAP).toBeLessThan(128);
});
