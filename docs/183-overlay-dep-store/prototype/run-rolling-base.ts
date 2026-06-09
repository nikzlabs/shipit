/**
 * PROTOTYPE harness — exercises rolling-base.ts against a REAL git repo and
 * prints both correctness results and timings for the cheap-path operations
 * the plan claims are negligible (commit-ancestry CAS + per-scope lock).
 *
 * Run:  npx tsx docs/183-overlay-dep-store/prototype/run-rolling-base.ts
 *
 * Settles (logic, on the copy substrate — open question #3 + several checklist
 * items): the publish CAS, marker skip, eligibility gates, ordering by commit
 * ancestry (not wall-clock), force-push divergence handling, and the depth-cap
 * flatten. Does NOT settle the host overlay mount (see host-overlay-spike.sh).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type PublishCandidate,
  type Scope,
  DEFAULT_DEPTH_CAP,
  isAncestor,
  markerAllowsSkip,
  publishBase,
  readPointer,
  runtimeFingerprint,
  withScopeLock,
} from "./rolling-base.ts";

// --- tiny test harness ------------------------------------------------------
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// --- real git repo fixture --------------------------------------------------
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): { dir: string; commit: (msg: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-git-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "proto@shipit.dev");
  git(dir, "config", "user.name", "proto");
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

// --- env ---------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ob-state-"));
const stateRoot = path.join(root, "state");
const lockRoot = path.join(root, "locks");
const baseRoot = path.join(root, "bases");
fs.mkdirSync(stateRoot, { recursive: true });
fs.mkdirSync(lockRoot, { recursive: true });
fs.mkdirSync(baseRoot, { recursive: true });

// Substrate hook — copy today, overlay later. Trivial here; this prototype
// validates the *decision* logic, not copy speed (host spike measures that).
let baseSeq = 0;
function materializeBase(_srcDir: string, fromEmpty: boolean): string {
  const dir = path.join(baseRoot, `base-${++baseSeq}-${fromEmpty ? "empty" : "incr"}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".from-empty"), String(fromEmpty));
  return dir;
}

const runtime = runtimeFingerprint({
  imageDigest: "sha256:img",
  arch: "x64",
  libc: "glibc-2.39",
  abiTags: ["node22", "cp312"],
});
const scope: Scope = { repo: "github.com/acme/app", runtime };

function candidate(over: Partial<PublishCandidate> & { commit: string }): PublishCandidate {
  return {
    scope,
    exitCode: 0,
    preUserInstall: true,
    sourceIsDefaultBranch: true,
    mergedDir: "/tmp/merged",
    ...over,
  };
}

async function main(): Promise<void> {
  const { dir: gitDir, commit } = makeRepo();
  const opts = { stateRoot, lockRoot, gitDir, materializeBase };

  const t1 = commit("t1");
  const t2 = commit("t2");
  const t3 = commit("t3");

  section("1. Cold start — first prep builds v0 from empty (under trust gate upstream)");
  {
    const r = await publishBase({ ...opts, candidate: candidate({ commit: t1 }) });
    check("outcome=created", r.outcome === "created", r.outcome);
    check("base.commit == t1", r.pointer?.commit === t1);
    check("depth == 1", r.pointer?.depth === 1);
    check("v0 materialized from empty", fs.existsSync(path.join(r.pointer!.baseDir, ".from-empty")));
  }

  section("2. main unchanged — marker skips install AND publish is a no-op (~0 work)");
  {
    const marker = { sourceCommit: t1, runtime, installCommand: "npm ci" };
    check(
      "markerAllowsSkip true on exact match",
      markerAllowsSkip(marker, { sourceCommit: t1, runtime, installCommand: "npm ci" }),
    );
    const r = await publishBase({ ...opts, candidate: candidate({ commit: t1 }) });
    check("outcome=skipped-equal", r.outcome === "skipped-equal", r.outcome);
    check("base still at t1", readPointer(stateRoot, scope)?.commit === t1);
  }

  section("3. main advanced its deps — incremental advance (depth++)");
  {
    const r = await publishBase({ ...opts, candidate: candidate({ commit: t2 }) });
    check("outcome=advanced", r.outcome === "advanced", r.outcome);
    check("base.commit == t2", r.pointer?.commit === t2);
    check("depth == 2", r.pointer?.depth === 2);
  }

  section("4. CAS ordering — a LATE but OLDER install can't clobber a newer base");
  {
    // base is at t2. First advance forward to t3...
    const fwd = await publishBase({ ...opts, candidate: candidate({ commit: t3 }) });
    check("advanced to t3", fwd.pointer?.commit === t3, fwd.outcome);
    // ...then an install that *recorded an older commit* (t2) grabs the lock LATE.
    const stale = await publishBase({ ...opts, candidate: candidate({ commit: t2 }) });
    check(
      "older candidate -> skipped-not-forward (ancestry, not wall-clock)",
      stale.outcome === "skipped-not-forward",
      stale.outcome,
    );
    check("base unchanged at t3", readPointer(stateRoot, scope)?.commit === t3);
  }

  section("5. Force-push divergence — diverged main is NOT forward, so skip");
  {
    // Rewrite main onto a sibling that does not descend t3.
    git(gitDir, "checkout", "-q", t1);
    git(gitDir, "checkout", "-q", "-b", "rewrite");
    fs.writeFileSync(path.join(gitDir, "forced.txt"), "forced");
    git(gitDir, "add", "-A");
    git(gitDir, "commit", "-q", "-m", "forced");
    const forced = git(gitDir, "rev-parse", "HEAD");
    git(gitDir, "checkout", "-q", "main");
    check("forced is NOT ancestor-descendant of t3", !isAncestor(gitDir, t3, forced) && !isAncestor(gitDir, forced, t3));
    const r = await publishBase({ ...opts, candidate: candidate({ commit: forced }) });
    check("outcome=skipped-not-forward", r.outcome === "skipped-not-forward", r.outcome);
    check("base still at t3 (waits for next genuinely-forward commit)", readPointer(stateRoot, scope)?.commit === t3);
  }

  section("6. Ineligible publishers run on the base but never publish");
  let t4 = "";
  {
    t4 = commit("t4"); // genuinely forward, so only eligibility blocks it
    const nonzero = await publishBase({ ...opts, candidate: candidate({ commit: t4, exitCode: 1 }) });
    check("exit!=0 -> skipped-ineligible", nonzero.outcome === "skipped-ineligible", nonzero.outcome);
    const userEdited = await publishBase({ ...opts, candidate: candidate({ commit: t4, preUserInstall: false }) });
    check("user-edited deps -> skipped-ineligible", userEdited.outcome === "skipped-ineligible", userEdited.outcome);
    const pinned = await publishBase({ ...opts, candidate: candidate({ commit: t4, sourceIsDefaultBranch: false }) });
    check("Ops source-pinned (non-default) -> skipped-ineligible", pinned.outcome === "skipped-ineligible", pinned.outcome);
    check("base STILL at t3 — none of the three published", readPointer(stateRoot, scope)?.commit === t3);
    // and a clean eligible one DOES advance to t4
    const ok = await publishBase({ ...opts, candidate: candidate({ commit: t4 }) });
    check("clean eligible advances to t4", ok.pointer?.commit === t4, ok.outcome);
  }

  section("6b. Marker invalidation for non-default checkout");
  {
    // A source-pinned session's marker stamped at a historical commit must not
    // let it skip install against the default-branch base.
    const defaultMarker = { sourceCommit: t4, runtime, installCommand: "npm ci" };
    check(
      "pinned checkout (different commit) cannot skip",
      !markerAllowsSkip(defaultMarker, { sourceCommit: t1, runtime, installCommand: "npm ci" }),
    );
    check(
      "different runtime cannot skip (ABI boundary)",
      !markerAllowsSkip(defaultMarker, { sourceCommit: t4, runtime: runtime + "|arm64", installCommand: "npm ci" }),
    );
    check(
      "different install command cannot skip",
      !markerAllowsSkip(defaultMarker, { sourceCommit: t4, runtime, installCommand: "npm install --omit=dev" }),
    );
  }

  section(`7. Depth cap (${DEFAULT_DEPTH_CAP}) -> clean reinstall from empty (flatten == reset)`);
  {
    // Fresh scope to count depth cleanly from v0.
    const s2: Scope = { repo: "github.com/acme/depth", runtime };
    const cand = (commitId: string): PublishCandidate => ({
      scope: s2,
      commit: commitId,
      exitCode: 0,
      preUserInstall: true,
      sourceIsDefaultBranch: true,
      mergedDir: "/tmp/merged",
    });
    // Build a long linear chain.
    const chain: string[] = [];
    const r2 = makeRepo();
    for (let i = 0; i < DEFAULT_DEPTH_CAP + 2; i++) chain.push(r2.commit(`c${i}`));
    const opts2 = { stateRoot, lockRoot, gitDir: r2.dir, materializeBase };

    let flattenedAt = -1;
    let maxDepth = 0;
    for (let i = 0; i < chain.length; i++) {
      const r = await publishBase({ ...opts2, candidate: cand(chain[i]) });
      const d = r.pointer?.depth ?? 0;
      maxDepth = Math.max(maxDepth, d);
      if (r.outcome === "flattened") {
        flattenedAt = i;
        check(`flatten resets depth to 1 (at step ${i})`, d === 1);
        check("flatten materializes from EMPTY", fs.readFileSync(path.join(r.pointer!.baseDir, ".from-empty"), "utf8") === "true");
      }
    }
    check("a flatten occurred", flattenedAt >= 0, `flattenedAt=${flattenedAt}`);
    check(`depth never reached the cap (${DEFAULT_DEPTH_CAP})`, maxDepth < DEFAULT_DEPTH_CAP, `maxDepth=${maxDepth}`);
    check("chain still points at newest commit", readPointer(stateRoot, s2)?.commit === chain[chain.length - 1]);
  }

  section("8. Concurrency — N parallel publishers, own uppers, lock-serialized publish");
  {
    const s3: Scope = { repo: "github.com/acme/race", runtime };
    const r3 = makeRepo();
    const chain: string[] = [];
    for (let i = 0; i < 12; i++) chain.push(r3.commit(`r${i}`));
    const opts3 = { stateRoot, lockRoot, gitDir: r3.dir, materializeBase };
    // Fire all forward candidates concurrently and in SHUFFLED order — the
    // final base must be the newest commit regardless of arrival order.
    const order = [...chain.keys()].sort((a, b) => ((a * 7 + 3) % 12) - ((b * 7 + 3) % 12));
    const results = await Promise.all(
      order.map((i) =>
        publishBase({
          ...opts3,
          candidate: {
            scope: s3,
            commit: chain[i],
            exitCode: 0,
            preUserInstall: true,
            sourceIsDefaultBranch: true,
            mergedDir: "/tmp/merged",
          },
        }),
      ),
    );
    const advances = results.filter((r) => r.outcome === "advanced" || r.outcome === "created" || r.outcome === "flattened").length;
    check("final base == newest commit despite shuffled arrival", readPointer(stateRoot, s3)?.commit === chain[chain.length - 1]);
    check("no torn pointer (state file parses)", readPointer(stateRoot, s3) !== null);
    console.log(`     (${advances} of ${results.length} concurrent publishers actually advanced; rest correctly skipped)`);
  }

  // --- timings: the operations the plan claims are negligible ---------------
  section("9. Timings — is the publish CAS actually cheap?");
  {
    const N = 2000;
    let t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) isAncestor(gitDir, t1, t2);
    const ancestorMs = Number(process.hrtime.bigint() - t) / 1e6 / N;

    t = process.hrtime.bigint();
    const L = 2000;
    for (let i = 0; i < L; i++) await withScopeLock(lockRoot, scope, () => {});
    const lockMs = Number(process.hrtime.bigint() - t) / 1e6 / L;

    console.log(`     git merge-base --is-ancestor : ${ancestorMs.toFixed(3)} ms/call (fork+exec dominates)`);
    console.log(`     acquire+release scope lock    : ${lockMs.toFixed(3)} ms/call`);
    check("ancestor check < 50ms/call", ancestorMs < 50, `${ancestorMs.toFixed(3)}ms`);
    check("lock cycle < 5ms/call", lockMs < 5, `${lockMs.toFixed(3)}ms`);
  }

  console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
