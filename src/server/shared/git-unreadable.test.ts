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
import { GitManager, classifyUnreadableAddFailure } from "./git.js";

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

describe("classifyUnreadableAddFailure — the cause, not just the symptom (planning#407)", () => {
  /**
   * What the real-git tests above CANNOT fail on: a failure that says
   * `unable to index file` for a reason other than permissions. An EIO needs a
   * failing disk and a mid-add deletion needs a race, so neither can be staged
   * in a container — and the old regex matched that line cause-agnostically, so
   * both were reported to the user as "fix that path's permissions" and
   * suppressed the commit as if they were the measured case.
   *
   * The messages here are git 2.39.5's own, transcribed from the measurement in
   * `docs/266-orchestrator-git-trust-boundary/requirements.md`. This test pins
   * the DISCRIMINATION; the real-git test above pins that the live wording still
   * matches at all.
   */
  it("classifies the permission case, naming the path from the open() line", () => {
    const message = [
      "error: open(\"d/server.key\"): Permission denied",
      "error: unable to index file 'd/server.key'",
      "fatal: updating files failed",
    ].join("\n");
    expect(classifyUnreadableAddFailure(message)).toEqual({ kind: "blocked", detail: "d/server.key" });
  });

  it("does NOT classify an index failure with no permission cause", () => {
    // Shape of an EIO or a file deleted between `status` and `add`: git names
    // the file it could not index and says nothing about permissions.
    const message = [
      "error: unable to index file 'data/blob.bin'",
      "fatal: updating files failed",
    ].join("\n");
    expect(classifyUnreadableAddFailure(message)).toBeNull();
  });

  it("does NOT classify an unrelated add failure", () => {
    const message = "fatal: Unable to create '/w/.git/index.lock': File exists.";
    expect(classifyUnreadableAddFailure(message)).toBeNull();
  });
});

describe("inspectWorkingTree — the question isClean() cannot answer (planning#407)", () => {
  it("reports the unreadable directory on a tree git calls CLEAN", async () => {
    // The data-loss path in one assertion. `tier-escalation` gates its wipe on
    // "is the work still only in the working tree?" — and git answers "no"
    // here, because it cannot see the work at all. Before the uid drop root
    // read everything and the answer was right by accident.
    fs.mkdirSync(path.join(repo, "pgdata"));
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "14\n");
    git("add", "-A");
    git("commit", "-qm", "add pgdata");
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "15\n");
    fs.chmodSync(path.join(repo, "pgdata"), 0o000);

    const mgr = new GitManager(repo);
    expect(await mgr.isClean()).toBe(true); // the trap
    expect(await mgr.inspectWorkingTree()).toEqual({
      clean: true,
      unreadable: { kind: "omitted", detail: "pgdata/" },
    });
  });

  it("reports an ordinary dirty tree with nothing unreadable", async () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "edit\n");
    expect(await new GitManager(repo).inspectWorkingTree()).toEqual({ clean: false, unreadable: null });
  });

  it("reports a clean, fully readable tree", async () => {
    expect(await new GitManager(repo).inspectWorkingTree()).toEqual({ clean: true, unreadable: null });
  });
});

/**
 * docs/266 — an unwritable `.git` costs the whole turn, and none of the cases
 * above can fail on it.
 *
 * Reported in production on 2026-08-16, hours after E1 made orchestrator-side
 * git drop to the tree's owner. Every test in this file makes a **worktree**
 * path unreadable, so the entire `.git` dimension was blind by construction —
 * which is why a failure on the path that carries a turn's work shipped
 * unnoticed.
 *
 * The distinction that matters, and the reason this needs its own block: the
 * cases above fail during `git add`, where `classifyUnreadableAddFailure` gives
 * the user a path to fix. This one fails at `commit`, **after** staging has
 * already succeeded — a different message, a different classifier answer, and a
 * worse state (work staged, nothing committed).
 *
 * Produced with a mode bit on a **self-owned** file rather than genuine foreign
 * ownership, the same limit the header states: a session container has no root.
 * The kernel check that fails is identical — `open(O_WRONLY)` on a `0444`
 * regular file is refused for the owner exactly as it is for a stranger.
 *
 * What that substitution cannot reproduce is the RECOVERY. In production the
 * file belongs to another uid and only root's chown can hand it over; here the
 * test process owns it and simply chmods it back, which is why the third case
 * below pins "nothing about the failure is sticky" and not "the chown works".
 * Joining the two halves — root chowns a foreign-owned `.git` to the uid git
 * then drops to — needs root, and remains unexercised (docs/266 plan §4).
 */
describe("autoCommit — unwritable .git/COMMIT_EDITMSG (the reported production failure)", () => {
  it("fails the commit, strands the staged work, and does not move HEAD", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    // git rewrites this file on every commit, so a stale one left by a uid the
    // current git is not is enough on its own — no unreadable worktree content
    // anywhere, which is what makes this distinct from every case above.
    const editMsg = path.join(repo, ".git", "COMMIT_EDITMSG");
    fs.writeFileSync(editMsg, "previous\n");
    fs.chmodSync(editMsg, 0o444);

    await expect(new GitManager(repo).autoCommit("a turn")).rejects.toThrow(/COMMIT_EDITMSG/);

    // Pin the exit code as well as the message: the notice path keys on text
    // (`GitError.exitCode` is undefined by construction), but the measurement
    // this test transcribes is "exit 128 at commit", and a future git that
    // demoted this to a warning would still match the regex above.
    let exitCode: number | null = null;
    try {
      execFileSync("git", ["commit", "-m", "second"], { cwd: repo, stdio: "pipe" });
    } catch (err) {
      exitCode = (err as { status: number }).status;
    }
    expect(exitCode).toBe(128);

    // The damage, in two assertions. HEAD never moved…
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim())
      .toBe(head);
    // …and the turn's work is STAGED, not merely dirty: `add -A` succeeded and
    // only `commit` failed. That is the state `CLAUDE.md` invariant 2 calls
    // unrecoverable — no reflog entry, and nothing but the working tree holding
    // it — and it is why the repair must run BEFORE the commit and not only in
    // the post-turn `finally`.
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repo, encoding: "utf-8",
    });
    expect(staged).toContain("tracked.txt");
  });

  it("is NOT classified as an add-time permission failure", async () => {
    // Pins WHY the user saw the generic req-15 notice rather than the tailored
    // one: git's wording here is `could not open '<path>': Permission denied`,
    // which is not the `open(<path>): Permission denied` shape the add-time
    // classifier keys on. Asserted so that a future widening of that regex is a
    // deliberate change with a red test, not an accident.
    const message = "fatal: could not open '.git/COMMIT_EDITMSG': Permission denied";
    expect(classifyUnreadableAddFailure(message)).toBeNull();
  });

  it("commits normally once .git is writable again — the repair converges", async () => {
    // The fix's observable effect. `chownWorkspaceGitToSessionWorker` cannot be
    // exercised here (it needs root to chown), so this pins the property that
    // makes it sufficient: nothing about the failure is sticky, so restoring
    // write access is the whole remedy.
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");
    const editMsg = path.join(repo, ".git", "COMMIT_EDITMSG");
    fs.writeFileSync(editMsg, "previous\n");
    fs.chmodSync(editMsg, 0o444);
    await expect(new GitManager(repo).autoCommit("a turn")).rejects.toThrow(/COMMIT_EDITMSG/);

    fs.chmodSync(editMsg, 0o644);

    const result = await new GitManager(repo).autoCommit("a turn");
    expect(result.commitHash).toBeTruthy();
    const tree = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: repo, encoding: "utf-8",
    });
    expect(tree).toContain("tracked.txt");
  });
});
