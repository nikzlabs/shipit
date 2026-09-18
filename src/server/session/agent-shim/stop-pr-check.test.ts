
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function runHook(opts: {
  cwd: string;
  ghScript: string;
  stdin?: string;
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

function makeRepo(opts: {
  commitsAheadOfBase: number;
  onDefaultBranch?: boolean;
}): { work: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "stop-pr-repo-"));

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

  writeFileSync(path.join(work, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: work });
  execFileSync("git", ["commit", "-m", "base"], { cwd: work });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: work });

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
  // Undo the push's tracking-ref update so only fetch reveals the new base.
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", stale], { cwd: work });
}

function ghPrView(pr: { state: string; merged?: boolean; baseRefName?: string }): string {
  const body = JSON.stringify({
    state: pr.state,
    merged: pr.merged ?? false,
    baseRefName: pr.baseRefName ?? "main",
  });
  return `echo '${body}'; exit 0`;
}

describe("stop-pr-check.sh", () => {
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
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
  });

  it("exits 0 when on the default branch (no PR concept)", () => {
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 0, onDefaultBranch: true }));
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
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 0 }));
    writeFileSync(path.join(cwd, "temp.txt"), "temp\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "add temp"], { cwd });
    execFileSync("git", ["rm", "temp.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "revert temp"], { cwd });
    const r = runHook({
      cwd,
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });


  it("blocks (exit 2) when the branch has progressed past its merged PR", () => {
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
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    const r = runHook({
      cwd,
      ghScript: ghPrView({ state: "closed", merged: true, baseRefName: "no-such-base" }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 when the base ref exists but cannot be freshened", () => {
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
    const cwd = trackRepo(makeRepo({ commitsAheadOfBase: 2 }));
    execFileSync("git", ["checkout", "--detach"], { cwd });
    const r = runHook({
      cwd,
      ghScript: 'echo "gh should not be invoked" 1>&2; exit 42',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 when a rebase is in progress (rebase-merge marker present)", () => {
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
