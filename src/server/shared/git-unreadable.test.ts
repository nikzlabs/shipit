/**
 * docs/266 reqs 14 + 15 — the two permission states, against real git.
 *
 * These are the measured cases from `docs/266-orchestrator-git-trust-boundary/plan.md`
 * §2, run here as executable assertions rather than as a table in prose. They
 * matter more than the usual unit test because the design's original
 * justification for accepting this residual — "the collision fails visibly" —
 * was **wrong**, and only measurement caught it. A regression here would
 * silently restore that wrongness: a turn that commits short, or does not
 * commit at all, with every exit code reporting success.
 *
 * The states are produced with mode bits on a self-owned directory rather than
 * genuine foreign ownership, because a session container has no root and
 * `unshare -r` is refused. The kernel check is the same one — a directory that
 * denies its own owner denies everyone — but the ownership dimension itself is
 * not exercised here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitManager } from "./git.js";

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, stdio: "pipe" });
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-unreadable-"));
  git("init", "-q", ".");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
});

afterEach(() => {
  // Restore modes first — rm -rf cannot descend into a 0000 directory either.
  for (const name of ["pgdata", "d"]) {
    const p = path.join(repo, name);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  }
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("autoCommit — unreadable DIRECTORY (req 14, the silent one)", () => {
  it("commits the readable work, reports the omission, and does not fail", async () => {
    // The turn's real work, plus a new directory git cannot descend into.
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");
    fs.mkdirSync(path.join(repo, "pgdata"));
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "14\n");
    fs.chmodSync(path.join(repo, "pgdata"), 0o000);

    const result = await new GitManager(repo).autoCommit("a turn");

    // The commit LANDS — that is what makes this the dangerous case. Every exit
    // code says the turn succeeded.
    expect(result.commitHash).toBeTruthy();
    expect(result.unreadable).toEqual({ kind: "omitted", detail: "pgdata/" });

    // …and the subtree really is absent from it, which is the damage the notice
    // has to describe.
    fs.chmodSync(path.join(repo, "pgdata"), 0o755);
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: repo, encoding: "utf-8",
    });
    expect(tree).toContain("tracked.txt");
    expect(tree).not.toContain("pgdata/PG_VERSION");
  });

  it("reports the omission when the unreadable dir hides the ONLY changes", async () => {
    // The case the first version of this feature was blind to, and the reason
    // the classification moved off `add -A` and onto `status`.
    //
    // When every change is inside the unreadable directory, git reports
    // "nothing to commit, working tree clean" and exits 0 — so `autoCommit`
    // took the clean-tree early return, made no commit, and said NOTHING. A
    // turn that produced work looked like a turn that produced none. Both of
    // the original tests kept a readable edit in the tree, which hid this by
    // construction: they could not fail on it.
    fs.mkdirSync(path.join(repo, "pgdata"));
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "14\n");
    git("add", "-A");
    git("commit", "-qm", "add pgdata");
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "15\n");
    fs.chmodSync(path.join(repo, "pgdata"), 0o000);

    const result = await new GitManager(repo).autoCommit("a turn");

    // git saw a clean tree, so there is no commit — but the user must still be
    // told, because their change is real and is not on the branch.
    expect(result.commitHash).toBeNull();
    expect(result.unreadable).toEqual({ kind: "omitted", detail: "pgdata/" });
  });

  it("reports nothing when every path is readable", async () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "ordinary turn\n");
    const result = await new GitManager(repo).autoCommit("a turn");
    expect(result.commitHash).toBeTruthy();
    expect(result.unreadable).toBeNull();
  });
});

describe("autoCommit — unreadable FILE (req 15, the total one)", () => {
  it("reports that NOTHING was committed, including unrelated work", async () => {
    // One unreadable file, plus an ordinary edit elsewhere in the tree. git
    // stages neither: `add -A` is all-or-nothing here.
    fs.mkdirSync(path.join(repo, "d"));
    fs.writeFileSync(path.join(repo, "d", "server.key"), "secret\n");
    git("add", "-A");
    git("commit", "-qm", "add key");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");
    fs.writeFileSync(path.join(repo, "d", "server.key"), "rotated\n");
    fs.chmodSync(path.join(repo, "d", "server.key"), 0o000);

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.commitHash).toBeNull();
    expect(result.unreadable?.kind).toBe("blocked");
    expect(result.unreadable?.detail).toContain("server.key");

    // The unrelated edit is still uncommitted and still on disk — which is the
    // whole reason req 15 demands this be reported as a failure and not logged.
    fs.chmodSync(path.join(repo, "d", "server.key"), 0o644);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" });
    expect(status).toContain("tracked.txt");
  });

  it("re-throws an add failure it does not recognise, rather than swallowing it", async () => {
    // The classifier must not become a catch-all: an unrelated `add` failure
    // has to keep reaching the caller as an error.
    const mgr = new GitManager(repo);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "edit\n");
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    await expect(mgr.autoCommit("a turn")).rejects.toThrow();
  });
});
