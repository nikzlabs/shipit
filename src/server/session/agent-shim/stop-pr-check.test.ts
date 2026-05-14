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
 *   stop_hook_active true            → exit 0 (avoid loops)
 *   not a git repo                   → exit 0
 *   no base branch resolvable        → exit 0
 *   on the default branch            → exit 0
 *   no commits ahead of base         → exit 0
 *   PR already exists (gh exit 0)    → exit 0
 *   gh fails with auth/config error  → exit 0 (fail open)
 *   commits + "No pull request found"→ exit 2 with stderr telling agent to act
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

  it("exits 0 when a PR already exists (gh exits 0)", () => {
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    const r = runHook({
      cwd,
      ghScript: 'echo \'{"url":"https://example/pr/1"}\'; exit 0',
    });
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
