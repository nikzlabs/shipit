/**
 * docs/266-orchestrator-git-trust-boundary E4 (reqs 9, 10). These run REAL git
 * against REAL hooks: the whole feature is what a `core.hooksPath` override
 * does to a child process, which no fake can be wrong about in the same way.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitManager } from "./git.js";
import { projectHooksAllowed } from "./git-tree-uid.js";

let repo: string;
// Outside the repo on purpose: a hook writing into the tree would change what
// there is left to commit, which is a different test.
let scratch: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo, stdio: "pipe", encoding: "utf-8",
  });
}

function writeHook(name: string, body: string): void {
  const hook = path.join(repo, ".git", "hooks", name);
  fs.writeFileSync(hook, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function commitCount(): number {
  return Number(git("rev-list", "--count", "HEAD").trim());
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-hooks-"));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-hooks-scratch-"));
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("autoCommit runs the project's own hooks (req 9)", () => {
  it("runs pre-commit, and its edits land in the same commit", async () => {
    writeHook("pre-commit", 'echo formatted > formatted.txt\ngit add formatted.txt');
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.hookFailure).toBeNull();
    expect(result.commitHash).toBeTruthy();
    const tree = git("ls-tree", "-r", "--name-only", "HEAD");
    expect(tree).toContain("formatted.txt");
  });

  // Hook output shares git's stdout, so a hook can print anything git prints.
  // Compared literally, not resolved: simple-git commits with core.abbrev=40,
  // so an abbreviated hash would be a silent contract change that `rev-parse`
  // would happily accept.
  it("reports the real commit, not a hash-shaped line a hook printed", async () => {
    writeHook("pre-commit", 'echo "[main deadbee] not a real commit"');
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.commitHash).toBe(git("rev-parse", "HEAD").trim());
    expect(result.commitHash).toHaveLength(40);
  });

  it("runs commit-msg, so a hook may rewrite the message", async () => {
    writeHook("commit-msg", 'printf "rewritten by the hook\\n" > "$1"');
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    await new GitManager(repo).autoCommit("a turn");

    expect(git("log", "-1", "--format=%s").trim()).toBe("rewritten by the hook");
  });

  it("gives a hook that reads stdin an EOF rather than waiting out the timeout", async () => {
    writeHook("pre-commit", 'cat > /dev/null');
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo, { commitHookTimeoutMs: 10_000 })
      .autoCommit("a turn");

    expect(result.hookFailure).toBeNull();
    expect(result.commitHash).toBeTruthy();
  });
});

describe("a hook cannot cost the turn its work (req 10)", () => {
  it("commits anyway when pre-commit exits non-zero, and reports what it printed", async () => {
    writeHook("pre-commit", 'echo "lint found 3 problems" >&2\nexit 1');
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.commitHash).toBeTruthy();
    expect(result.hookFailure?.kind).toBe("failed");
    expect(result.hookFailure?.output).toContain("lint found 3 problems");
    expect(git("show", "--name-only", "--format=", "HEAD")).toContain("tracked.txt");
  });

  it("kills a hanging pre-commit, commits, and leaves no orphan behind", async () => {
    const pidFile = path.join(scratch, "child.pid");
    writeHook("pre-commit", `sleep 120 & echo $! > ${pidFile}\nwait`);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo, { commitHookTimeoutMs: 700 })
      .autoCommit("a turn");

    expect(result.hookFailure?.kind).toBe("timeout");
    expect(result.commitHash).toBeTruthy();
    expect(commitCount()).toBe(2);

    // The hook's own child outlives a pid-only kill; killProcessTree is why it does not.
    const childPid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  // Measured against git 2.39.5: git ignores post-commit's exit status, so there
  // is nothing for ShipIt to report and nothing to retry.
  it("reports nothing when post-commit fails, because git does not either", async () => {
    writeHook("post-commit", 'echo "notify failed" >&2\nexit 1');
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.hookFailure).toBeNull();
    expect(result.commitHash).toBeTruthy();
    expect(commitCount()).toBe(2);
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  it("does not report a hook failure when a hanging post-commit already committed", async () => {
    const pidFile = path.join(scratch, "child.pid");
    writeHook("post-commit", `sleep 120 & echo $! > ${pidFile}\nwait`);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo, { commitHookTimeoutMs: 700 })
      .autoCommit("a turn");

    expect(result.hookFailure?.kind).toBe("timeout");
    // The turn IS on the branch; a second commit attempt would find nothing and throw.
    expect(result.commitHash).toBeTruthy();
    expect(commitCount()).toBe(2);
  });

  // lint-staged — the commonest pre-commit setup in a JS project — stashes and
  // restores the index, so a hook leaving it changed is the ordinary case, not
  // an adversarial one. The exit code says nothing about what is left to commit.
  it("recovers the turn's work when the failing hook unstaged it", async () => {
    writeHook("pre-commit", 'git reset -q HEAD -- tracked.txt\nexit 1');
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.hookFailure?.kind).toBe("failed");
    expect(result.commitHash).toBeTruthy();
    expect(git("show", "--name-only", "--format=", "HEAD")).toContain("tracked.txt");
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  // `close` waits for git's stdout pipe, which a backgrounded grandchild holds
  // open after git itself exits — and the timeout cannot reach a process whose
  // parent is already gone. Settling on `exit` is what bounds this.
  it("is not held open by a hook that backgrounds a child and exits", async () => {
    const pidFile = path.join(scratch, "daemon.pid");
    writeHook("pre-commit", `sleep 120 & echo $! > ${pidFile}\nexit 1`);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const started = Date.now();
    const result = await new GitManager(repo, { commitHookTimeoutMs: 30_000 })
      .autoCommit("a turn");

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.hookFailure?.kind).toBe("failed");
    expect(result.commitHash).toBeTruthy();

    try {
      process.kill(Number(fs.readFileSync(pidFile, "utf-8").trim()), "SIGKILL");
    } catch {
      // Already gone.
    }
  });

  // The scan upstream of the commit ran on the paths the TURN staged. Anything
  // the hook wrote is new, and this commit is auto-pushed.
  it("rescans what a failing hook wrote, and refuses a secret it added", async () => {
    const token = `ghp_${"0".repeat(32)}abcd`;
    writeHook("pre-commit", `echo "token=${token}" > leaked.env\nexit 1`);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.secretFindings.length).toBeGreaterThan(0);
    expect(result.commitHash).toBeNull();
    expect(commitCount()).toBe(1);
    // Unstaged, not destroyed — the work is still there to correct.
    expect(git("status", "--porcelain")).toContain("tracked.txt");
  });

  // A null commitHash reads as "nothing to commit" to the merge route and the
  // eviction gate, so a hook that hid the work must not produce one (req 15).
  it("fails the turn loudly when the hook stashed the work away", async () => {
    writeHook("pre-commit", "git stash push -u -q\nexit 1");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    await expect(new GitManager(repo).autoCommit("a turn"))
      .rejects.toThrow(/left nothing to commit/);
    expect(commitCount()).toBe(1);
  });

  // Re-staging is best-effort: the index the hook was handed already holds the
  // turn's work, and losing it to a second `add` would be the bug req 10 names.
  it("still commits the staged work when re-staging fails", async () => {
    writeHook("pre-commit", "chmod 000 tracked.txt\nexit 1");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");
    fs.chmodSync(path.join(repo, "tracked.txt"), 0o644);

    expect(result.hookFailure?.kind).toBe("failed");
    expect(result.commitHash).toBeTruthy();
    expect(git("show", "HEAD:tracked.txt")).toBe("agent edit\n");
  });

  // A hook that traps SIGTERM outlives the kill; killProcessTree escalates to
  // SIGKILL after its grace. ShipIt does not wait for that — see plan.md §2
  // (E4 as built) for why that residual is accepted rather than closed.
  it("commits without waiting on a hook that refuses SIGTERM", async () => {
    writeHook("pre-commit", 'trap "" TERM\nsleep 30');
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const started = Date.now();
    const result = await new GitManager(repo, { commitHookTimeoutMs: 500 })
      .autoCommit("a turn");

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.hookFailure?.kind).toBe("timeout");
    expect(result.commitHash).toBeTruthy();
  });

  it("redacts a secret a hook echoed before it failed", async () => {
    // Assembled at runtime so this fixture is not itself a secret in the diff.
    const token = `ghp_${"0".repeat(32)}abcd`;
    writeHook("pre-commit", `echo "deploying with ${token}" >&2\nexit 1`);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.hookFailure?.output).not.toContain(token);
    expect(result.hookFailure?.output).toContain("deploying with");
  });
});

describe("projectHooksAllowed — repo-controlled code never runs with root authority", () => {
  it("allows hooks when this process is not root", () => {
    expect(projectHooksAllowed({}, () => 1000)).toBe(true);
    expect(projectHooksAllowed({ uid: 1000 }, () => 1000)).toBe(true);
  });

  it("allows hooks as root only when the spawn drops to the tree's owner", () => {
    expect(projectHooksAllowed({ uid: 1000 }, () => 0)).toBe(true);
    expect(projectHooksAllowed({}, () => 0)).toBe(false);
  });

  // SHIPIT_SESSION_WORKER_UID=0 is accepted and becomes the fallback identity
  // for a root-owned legacy session dir, so `uid: 0` is a drop that arrives at
  // root — the one shape a truthiness check on `uid` would wave through.
  it("refuses a drop whose destination is root", () => {
    expect(projectHooksAllowed({ uid: 0 }, () => 0)).toBe(false);
    expect(projectHooksAllowed({ uid: 0 }, () => 1000)).toBe(false);
  });

  it("treats a platform without getuid as root, not as safe", () => {
    expect(projectHooksAllowed({}, () => undefined)).toBe(false);
  });
});
