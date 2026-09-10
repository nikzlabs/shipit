// Mode bits test access failures, not foreign ownership or root's chown recovery.

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
  // Restore directory traversal before cleanup.
  for (const name of ["pgdata", "d"]) {
    const p = path.join(repo, name);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  }
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("autoCommit — unreadable DIRECTORY (req 14, the silent one)", () => {
  it("commits the readable work, reports the omission, and does not fail", async () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");
    fs.mkdirSync(path.join(repo, "pgdata"));
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "14\n");
    fs.chmodSync(path.join(repo, "pgdata"), 0o000);

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.commitHash).toBeTruthy();
    expect(result.unreadable).toEqual({ kind: "omitted", detail: "pgdata/" });

    fs.chmodSync(path.join(repo, "pgdata"), 0o755);
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: repo, encoding: "utf-8",
    });
    expect(tree).toContain("tracked.txt");
    expect(tree).not.toContain("pgdata/PG_VERSION");
  });

  it("reports the omission when the unreadable dir hides the ONLY changes", async () => {
    fs.mkdirSync(path.join(repo, "pgdata"));
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "14\n");
    git("add", "-A");
    git("commit", "-qm", "add pgdata");
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "15\n");
    fs.chmodSync(path.join(repo, "pgdata"), 0o000);

    const result = await new GitManager(repo).autoCommit("a turn");

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

    fs.chmodSync(path.join(repo, "d", "server.key"), 0o644);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" });
    expect(status).toContain("tracked.txt");
  });

  it("re-throws an add failure it does not recognise, rather than swallowing it", async () => {
    const mgr = new GitManager(repo);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "edit\n");
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    await expect(mgr.autoCommit("a turn")).rejects.toThrow();
  });
});

describe("classifyUnreadableAddFailure — the cause, not just the symptom (planning#407)", () => {
  it("classifies the permission case, naming the path from the open() line", () => {
    const message = [
      "error: open(\"d/server.key\"): Permission denied",
      "error: unable to index file 'd/server.key'",
      "fatal: updating files failed",
    ].join("\n");
    expect(classifyUnreadableAddFailure(message)).toEqual({ kind: "blocked", detail: "d/server.key" });
  });

  it("does NOT classify an index failure with no permission cause", () => {
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
    fs.mkdirSync(path.join(repo, "pgdata"));
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "14\n");
    git("add", "-A");
    git("commit", "-qm", "add pgdata");
    fs.writeFileSync(path.join(repo, "pgdata", "PG_VERSION"), "15\n");
    fs.chmodSync(path.join(repo, "pgdata"), 0o000);

    const mgr = new GitManager(repo);
    expect(await mgr.isClean()).toBe(true);
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

describe("autoCommit — unwritable .git/COMMIT_EDITMSG (the reported production failure)", () => {
  it("fails the commit, strands the staged work, and does not move HEAD", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const editMsg = path.join(repo, ".git", "COMMIT_EDITMSG");
    fs.writeFileSync(editMsg, "previous\n");
    fs.chmodSync(editMsg, 0o444);

    await expect(new GitManager(repo).autoCommit("a turn")).rejects.toThrow(/COMMIT_EDITMSG/);

    let exitCode: number | null = null;
    try {
      execFileSync("git", ["commit", "-m", "second"], { cwd: repo, stdio: "pipe" });
    } catch (err) {
      exitCode = (err as { status: number }).status;
    }
    expect(exitCode).toBe(128);

    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim())
      .toBe(head);
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repo, encoding: "utf-8",
    });
    expect(staged).toContain("tracked.txt");
  });

  it("is NOT classified as an add-time permission failure", async () => {
    const message = "fatal: could not open '.git/COMMIT_EDITMSG': Permission denied";
    expect(classifyUnreadableAddFailure(message)).toBeNull();
  });

  it("commits normally once .git is writable again — the repair converges", async () => {
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
