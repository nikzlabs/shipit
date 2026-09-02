/**
 * Tests for docker/agent-hooks/stop-pr-check.sh — the Claude Code Stop hook
 * that enforces PR creation after a meaningful turn.
 *
 * Strategy: run the script in a temp git repo with the real /bin/sh, but with
 * a stubbed `gh` (and sometimes a stubbed `git` for default-branch resolution)
 * placed earlier on PATH. This exercises the actual shell logic — branching,
 * exit codes, stderr content — without depending on a real GitHub backend.
 *
 * Decision table (matches the script's flow):
 *   stop_hook_active true             → exit 0 (avoid loops)
 *   not a git repo                    → exit 0
 *   transient state (detached HEAD,   → exit 0 (can't/shouldn't PR mid-op;
 *     rebase/merge/cherry-pick)            re-check after it finishes)
 *   no base branch resolvable         → exit 0
 *   on the default branch             → exit 0
 *   no commits ahead of base          → exit 0
 *   empty net diff vs base            → exit 0 (revert / merged-then-rebased)
 *   an OPEN PR exists                 → exit 0 (the work shipped)
 *   a MERGED/CLOSED PR exists, and
 *     the branch has NOT progressed   → exit 0 (`gh pr create` would refuse)
 *     the branch HAS progressed       → exit 2 (the new commits are unshipped)
 *   gh fails with auth/config error   → exit 0 (fail open)
 *   commits + diff + "No PR found"    → exit 2 with stderr telling agent to act
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Test lives next to gh.ts so it's picked up by vitest's src/server/** include
// glob, but the hook script ships from docker/agent-hooks/ (it's baked into
// the session-worker image and run by the Claude CLI inside containers).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "docker",
  "agent-hooks",
  "stop-pr-check.sh",
);

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the hook with a synthetic environment. `ghScript` is the body of a
 * shell script that will be installed as the first `gh` on PATH. `stdin` is
 * the JSON envelope that Claude Code would normally pass.
 */
function runHook(opts: {
  cwd: string;
  ghScript: string;
  stdin?: string;
  /**
   * Value of SHIPIT_AUTO_CREATE_PR in the hook's environment. The hook
   * self-gates on this var (set to "1" by the orchestrator only when
   * autoCreatePr is on). Defaults to "1" so the existing decision-table
   * tests exercise the enforcement path; pass `undefined` to test the gate.
   */
  autoCreatePr?: string;
}): Result {
  const binDir = mkdtempSync(path.join(tmpdir(), "stop-pr-bin-"));
  const ghPath = path.join(binDir, "gh");
  writeFileSync(ghPath, `#!/bin/sh\n${opts.ghScript}\n`);
  chmodSync(ghPath, 0o755);

  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: opts.cwd,
  };
  const autoCreatePr = "autoCreatePr" in opts ? opts.autoCreatePr : "1";
  if (autoCreatePr === undefined) {
    delete env.SHIPIT_AUTO_CREATE_PR;
  } else {
    env.SHIPIT_AUTO_CREATE_PR = autoCreatePr;
  }

  const r = spawnSync("/bin/sh", [HOOK_SCRIPT], {
    cwd: opts.cwd,
    input: opts.stdin ?? "{}",
    env,
    encoding: "utf8",
  });

  rmSync(binDir, { recursive: true, force: true });

  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Initialize a git repo with origin/main pointing at a base commit, then
 * optionally add commits on a feature branch ahead of main. Returns the
 * working-tree dir AND the temp-root that should be cleaned up.
 */
function makeRepo(opts: {
  commitsAheadOfBase: number;
  onDefaultBranch?: boolean;
}): { work: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "stop-pr-repo-"));

  // Bare "remote" — gives us a real `origin/main` ref.
  const remote = path.join(root, "remote.git");
  mkdirSync(remote);
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);

  const work = path.join(root, "work");
  mkdirSync(work);
  execFileSync("git", ["init", "-b", "main"], { cwd: work });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: work });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: work });

  // Base commit on main, pushed.
  writeFileSync(path.join(work, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: work });
  execFileSync("git", ["commit", "-m", "base"], { cwd: work });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: work });

  // Set origin/HEAD so `git symbolic-ref refs/remotes/origin/HEAD` resolves.
  execFileSync("git", ["remote", "set-head", "origin", "main"], { cwd: work });

  if (!opts.onDefaultBranch) {
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: work });
  }

  for (let i = 0; i < opts.commitsAheadOfBase; i++) {
    writeFileSync(path.join(work, `file-${i}.txt`), `${i}\n`);
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-m", `feature ${i}`], { cwd: work });
  }

  return { work, root };
}

/**
 * Land a commit on the *remote's* main while leaving this clone's
 * `origin/main` pointing where it was — the "another session merged while you
 * worked" shape. Only a `git fetch` reveals the new tip, so a hook that skips
 * the fetch reads a stale ref and mis-answers the containment check.
 */
function advanceRemoteBase(work: string): void {
  const stale = execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: work,
    encoding: "utf8",
  }).trim();
  const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: work,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["checkout", "-b", "tmp-advance", stale], { cwd: work });
  writeFileSync(path.join(work, "other-session.txt"), "other\n");
  execFileSync("git", ["add", "."], { cwd: work });
  execFileSync("git", ["commit", "-m", "another session's work"], { cwd: work });
  execFileSync("git", ["push", "origin", "HEAD:main"], { cwd: work });
  execFileSync("git", ["checkout", branch], { cwd: work });
  execFileSync("git", ["branch", "-D", "tmp-advance"], { cwd: work });
  // The push moved the remote-tracking ref; put it back so the clone is stale.
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", stale], { cwd: work });
}

/** A `gh pr view --json state,merged,baseRefName` stub for a PR in some state. */
function ghPrView(pr: { state: string; merged?: boolean; baseRefName?: string }): string {
  const body = JSON.stringify({
    state: pr.state,
    merged: pr.merged ?? false,
    baseRefName: pr.baseRefName ?? "main",
  });
  return `echo '${body}'; exit 0`;
}

describe("stop-pr-check.sh", () => {
  // Track temp roots created during a test so afterEach can rm them. Use the
  // root path itself, not a parent — rm'ing the parent would wipe /tmp.
  let trash: string[] = [];
  beforeEach(() => { trash = []; });
  afterEach(() => {
    for (const dir of trash) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  function trackRepo(r: { work: string; root: string }): string {
    trash.push(r.root);
    return r.work;
  }
  function trackDir(dir: string): string {
    trash.push(dir);
    return dir;
  }

  it("exits 0 when stop_hook_active is true (no loops)", () => {
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 3 }));
    const r = runHook({
      cwd,
      ghScript: 'echo "No pull request found" 1>&2; exit 1',
      stdin: JSON.stringify({ stop_hook_active: true, hook_event_name: "Stop" }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 when there's no git repo", () => {
    const dir = trackDir(mkdtempSync(path.join(tmpdir(), "no-git-")));
    const r = runHook({ cwd: dir, ghScript: "exit 99" });
    expect(r.status).toBe(0);
  });

  it("exits 0 when no commits are ahead of base", () => {
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 0 }));
    const r = runHook({
      cwd,
      // gh should never even be called; if it is, treat that as a failure.
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
  });

  it("exits 0 when on the default branch (no PR concept)", () => {
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 0, onDefaultBranch: true }));
    // Even with new local commits, on `main` there's no PR to open.
    writeFileSync(path.join(cwd, "x.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "x"], { cwd });
    const r = runHook({
      cwd,
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
  });

  it("exits 0 when an open PR already exists", () => {
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    const r = runHook({ cwd, ghScript: ghPrView({ state: "open" }) });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 (fail-open) when gh errors for a reason other than 'No pull request found'", () => {
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    const r = runHook({
      cwd,
      ghScript: 'echo "GitHub is not connected for this ShipIt session." 1>&2; exit 1',
    });
    expect(r.status).toBe(0);
  });

  it("exits 0 (fail-open) when the net diff vs base is empty despite commits ahead", () => {
    // A revert: add a file, then remove it. `git rev-list` shows 2 commits
    // ahead, but `git diff base...HEAD` is empty — no PR should be forced.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 0 }));
    writeFileSync(path.join(cwd, "temp.txt"), "temp\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "add temp"], { cwd });
    execFileSync("git", ["rm", "temp.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "revert temp"], { cwd });
    const r = runHook({
      cwd,
      // gh must never be reached — the net-diff gate exits first.
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  // --- a merged/closed PR: proof of shipping only while the branch hasn't
  // moved past it. GitHub's REST spelling makes a merged PR read as `closed`,
  // so `merged` is what tells a merge from an abandon.

  it("blocks (exit 2) when the branch has progressed past its merged PR", () => {
    // The branch sits on the current base tip with new commits on top — the
    // exact state in which `gh pr create` opens a REPLACEMENT PR. The merged
    // PR is from an earlier turn and shipped none of this, so staying quiet
    // would leave the work unshipped with nothing saying so.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    const r = runHook({
      cwd,
      ghScript: ghPrView({ state: "closed", merged: true }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("merged");
    expect(r.stderr).toContain("NOT shipped");
    expect(r.stderr).toContain("gh pr create");
  });

  it("blocks (exit 2) naming CLOSED when the branch's last PR was abandoned", () => {
    // `state: closed, merged: false` — the PR was closed, not merged. ShipIt
    // does not reopen one, so the wording must not claim a merge.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    const r = runHook({
      cwd,
      ghScript: ghPrView({ state: "closed", merged: false }),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("closed");
    expect(r.stderr).not.toContain("merged");
  });

  it("exits 0 when a merged PR exists and the base has moved on under the branch", () => {
    // `base-not-contained`: another session merged while this one worked, so
    // the branch no longer contains the base tip. `gh pr create` refuses this
    // shape, so blocking would demand an action that cannot succeed.
    //
    // Doubles as the fetch guard: the new base tip is only on the remote, so a
    // hook that skips `git fetch` reads the stale ref, finds merge-base ==
    // (stale) base tip, and wrongly blocks.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    advanceRemoteBase(cwd);
    const r = runHook({
      cwd,
      ghScript: ghPrView({ state: "closed", merged: true }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 when the merged PR's base cannot be resolved in this clone", () => {
    // The PR targeted a branch this clone has no ref for and the fetch cannot
    // produce one. We can't tell whether the branch progressed, so fail open
    // rather than substitute the local base and answer a different question.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    const r = runHook({
      cwd,
      ghScript: ghPrView({ state: "closed", merged: true, baseRefName: "no-such-base" }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 when the base ref exists but cannot be freshened", () => {
    // The reviewer's case, and the sharpest one: a fetch that FAILS leaves a
    // stale `origin/main` behind — and against a stale ref the containment
    // clause is trivially satisfied, so an already-shipped branch reads as
    // "progressed". Deciding from a ref we know we could not refresh is how
    // this hook would nag about work that merged yesterday.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    execFileSync("git", ["remote", "set-url", "origin", path.join(cwd, "gone.git")], { cwd });
    const r = runHook({
      cwd,
      ghScript: ghPrView({ state: "closed", merged: true }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 when the branch has no new work over the PR's own base", () => {
    // `no-new-work`, reachable because the two gates use different bases: the
    // early three-dot gate compares against the repo's default base, while the
    // progress check compares against the PR's. A branch sitting exactly on
    // `stable` differs from `main` (so it clears the early gate) yet has an
    // empty diff over `stable` — nothing to open a PR for.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 1 }));
    execFileSync("git", ["push", "origin", "HEAD:stable"], { cwd });
    const r = runHook({
      cwd,
      ghScript: ghPrView({ state: "closed", merged: true, baseRefName: "stable" }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("blocks (exit 2) with guidance when commits exist and no PR exists", () => {
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 1 }));
    const r = runHook({
      cwd,
      ghScript: 'echo "No pull request found for this branch." 1>&2; exit 1',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("gh pr create");
    expect(r.stderr).toContain("Summary");
    expect(r.stderr).toContain("Test plan");
  });

  it("exits 0 when HEAD is detached (mid-rebase / bare SHA checkout)", () => {
    // During a rebase HEAD is detached, so `gh pr create` cannot push to a
    // branch. The hook must fail open instead of forcing an impossible action,
    // even with commits ahead + a real diff + no PR.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    execFileSync("git", ["checkout", "--detach"], { cwd });
    const r = runHook({
      cwd,
      // gh must never be reached — the transient-state guard exits first.
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 when a rebase is in progress (rebase-merge marker present)", () => {
    // Simulate an in-progress rebase by creating the marker dir git uses; HEAD
    // stays on the branch but the tree is transient, so the hook fails open.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    mkdirSync(path.join(cwd, ".git", "rebase-merge"));
    const r = runHook({
      cwd,
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 when a merge is in progress (MERGE_HEAD present)", () => {
    // A conflicted/in-progress merge leaves MERGE_HEAD; fail open until it
    // resolves rather than blocking the turn.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    writeFileSync(path.join(cwd, ".git", "MERGE_HEAD"), `${headSha}\n`);
    const r = runHook({
      cwd,
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 (no enforcement) when SHIPIT_AUTO_CREATE_PR is unset", () => {
    // The settings file is always wired up so the PreToolUse branch-block
    // hook runs, but PR enforcement is gated: without the env var the Stop
    // hook does nothing, even when commits exist and no PR is open.
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 1 }));
    const r = runHook({
      cwd,
      autoCreatePr: undefined,
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});
