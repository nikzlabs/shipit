import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { pushLfsObjects, lfsDeclarationGrepArgs, LfsUploadError } from "./git-lfs-push.js";
import { safeSimpleGit } from "./git-hooks-guard.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("pushLfsObjects", () => {
  let root: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-push-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");

    workDir = path.join(root, "work");
    fs.mkdirSync(workDir);
    run("git init -b main", workDir);
    fs.writeFileSync(path.join(workDir, "readme.md"), "hello\n");
    run("git add -A && git commit -m init", workDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs nothing on a repo that tracks nothing with LFS", async () => {
    const outcome = await pushLfsObjects((o) => safeSimpleGit(workDir, o), "origin", "main");
    expect(outcome.status).toBe("not-an-lfs-repo");
  });

  it("ignores a `.gitattributes` that declares no LFS filter", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.md text eol=lf\n");
    run("git add -A && git commit -m attrs", workDir);

    const outcome = await pushLfsObjects((o) => safeSimpleGit(workDir, o), "origin", "main");
    expect(outcome.status).toBe("not-an-lfs-repo");
  });

  it("attempts the upload when a nested `.gitattributes` declares LFS", async () => {
    fs.mkdirSync(path.join(workDir, "assets"));
    fs.writeFileSync(
      path.join(workDir, "assets", ".gitattributes"),
      "*.png filter=lfs diff=lfs merge=lfs -text\n",
    );
    run("git add -A && git commit -m attrs", workDir);

    // No LFS endpoint: assert the upload attempt, not its success.
    const bare = path.join(root, "bare.git");
    fs.mkdirSync(bare);
    run("git init --bare -b main", bare);
    run(`git remote add origin ${bare}`, workDir);

    const outcome = await pushLfsObjects((o) => safeSimpleGit(workDir, o), "origin", "main");
    expect(outcome.status).not.toBe("not-an-lfs-repo");
  });

  it("asks about the branch being published, not about HEAD", async () => {
    run("git checkout -q -b assets", workDir);
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);
    run("git checkout -q main", workDir);

    expect((await pushLfsObjects((o) => safeSimpleGit(workDir, o), "origin", "main")).status)
      .toBe("not-an-lfs-repo");
    expect((await pushLfsObjects((o) => safeSimpleGit(workDir, o), "origin", "assets")).status)
      .not.toBe("not-an-lfs-repo");
  });

  it("falls back to HEAD when the named branch does not resolve", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);

    expect((await pushLfsObjects((o) => safeSimpleGit(workDir, o), "origin", "no-such-branch")).status)
      .not.toBe("not-an-lfs-repo");
  });

  it("reports a failed upload instead of throwing", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);
    const outcome = await pushLfsObjects((o) => safeSimpleGit(workDir, o), "nope", "main");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.detail).not.toBe("");
  });

  // The session container has git-lfs, so its pointers can reach a push the orchestrator cannot upload.
  it("treats a missing git-lfs binary as a failed upload", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);
    // A PATH holding only git: git resolves `git lfs` to a `git-lfs` binary on PATH.
    const noLfs = path.join(root, "no-lfs-bin");
    fs.mkdirSync(noLfs);
    fs.symlinkSync(run("command -v git", workDir).trim(), path.join(noLfs, "git"));
    // simple-git refuses an inherited GIT_CONFIG_GLOBAL / GIT_EDITOR, so start from nothing.
    const outcome = await pushLfsObjects(
      (o) => safeSimpleGit(workDir, o).env({ PATH: noLfs, HOME: root }),
      "origin",
      "main",
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.detail).toContain("not a git command");
  });

  // git-lfs prints this failure on stdout, which simple-git alone resolves as success.
  it("reports an object that exists neither locally nor on the LFS server", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    const pointer = run(
      `printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:${"0".repeat(64)}\\nsize 42\\n' | git hash-object -w --stdin`,
      workDir,
    ).trim();
    // By name: `git add -A` would stage the deletion of a.bin, which has no working-tree file.
    run(`git update-index --add --cacheinfo 100644,${pointer},a.bin`, workDir);
    run("git add .gitattributes && git commit -q -m 'pointer without an object'", workDir);
    const bare = path.join(root, "bare.git");
    fs.mkdirSync(bare);
    run("git init --bare -b main", bare);
    run(`git remote add origin ${bare}`, workDir);

    const outcome = await pushLfsObjects((o) => safeSimpleGit(workDir, o), "origin", "main");

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.detail).toContain("(missing) a.bin");
      expect(outcome.detail).not.toContain("allowincompletepush");
    }
  });

  it("answers 'no' rather than throwing on a repo with no commits", async () => {
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    run("git init -b main", empty);
    const outcome = await pushLfsObjects((o) => safeSimpleGit(empty, o), "origin", "main");
    expect(outcome.status).toBe("not-an-lfs-repo");
  });

  it("scopes the detection grep to the ref it is given", () => {
    expect(lfsDeclarationGrepArgs()).toContain("HEAD");
    expect(lfsDeclarationGrepArgs("refs/heads/other")).toContain("refs/heads/other");
    expect(lfsDeclarationGrepArgs()).toContain("*.gitattributes");
  });
});

// Real git-lfs, so "nothing to upload" and "upload failed" are git-lfs's answers, not a stub's.
describe("GitManager.push in a repository that tracks files with Git LFS", () => {
  let root: string;
  let bareDir: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  const remoteTip = (): string | null => {
    try {
      return run("git rev-parse refs/heads/main", bareDir).trim();
    } catch {
      return null;
    }
  };

  const commitAsset = (): void => {
    fs.writeFileSync(path.join(workDir, "art.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    run("git add -A && git commit -q -m art", workDir);
    expect(run("git cat-file -p HEAD:art.png", workDir)).toContain("git-lfs.github.com/spec/v1");
  };

  const commitAsset2 = (): void => {
    fs.writeFileSync(path.join(workDir, "art2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]));
    run("git add -A && git commit -q -m art2", workDir);
  };

  // A committed `.lfsconfig` naming an LFS server that is not the git remote.
  const pointLfsAtDeadServer = (): void => {
    fs.writeFileSync(path.join(workDir, ".lfsconfig"), "[lfs]\n\turl = http://127.0.0.1:1/lfs\n");
    run("git add -A && git commit -q -m lfsconfig", workDir);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-pushfail-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");

    bareDir = path.join(root, "bare.git");
    workDir = path.join(root, "work");
    fs.mkdirSync(bareDir);
    fs.mkdirSync(workDir);
    run("git init --bare -b main", bareDir);

    run("git init -b main", workDir);
    run(`git remote add origin ${bareDir}`, workDir);
    fs.writeFileSync(
      path.join(workDir, ".gitattributes"),
      "*.png filter=lfs diff=lfs merge=lfs -text\n",
    );
    fs.writeFileSync(path.join(workDir, "readme.md"), "hello\n");
    run("git add -A && git commit -q -m init", workDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("uploads the objects, then pushes the ref", async () => {
    commitAsset();
    const oid = /oid sha256:([0-9a-f]{64})/.exec(run("git cat-file -p HEAD:art.png", workDir))?.[1] ?? "";

    await new GitManager(workDir).push("origin", "main");

    expect(remoteTip()).toBe(run("git rev-parse HEAD", workDir).trim());
    expect(fs.existsSync(path.join(bareDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid))).toBe(true);
  });

  it("does not push the ref when the LFS server cannot take the objects", async () => {
    pointLfsAtDeadServer();
    commitAsset();

    const push = new GitManager(workDir).push("origin", "main");

    await expect(push).rejects.toBeInstanceOf(LfsUploadError);
    await expect(push).rejects.toThrow(/127\.0\.0\.1:1/);
    expect(remoteTip()).toBeNull();
  });

  it("refuses when a committed `.lfsconfig` allows an incomplete push and an object exists nowhere", async () => {
    fs.writeFileSync(path.join(workDir, ".lfsconfig"), "[lfs]\n\tallowincompletepush = true\n");
    const oid = "0".repeat(64);
    const pointer = run(
      `printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:${oid}\\nsize 42\\n' | git hash-object -w --stdin`,
      workDir,
    ).trim();
    run(`git update-index --add --cacheinfo 100644,${pointer},art.png`, workDir);
    run("git add .lfsconfig && git commit -q -m 'pointer without an object'", workDir);

    await expect(new GitManager(workDir).push("origin", "main")).rejects.toBeInstanceOf(LfsUploadError);
    expect(remoteTip()).toBeNull();
  });

  it("uploads a pointer whose LFS declaration a later unpushed commit removed", async () => {
    commitAsset();
    const oid = /oid sha256:([0-9a-f]{64})/.exec(run("git cat-file -p HEAD:art.png", workDir))?.[1] ?? "";
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.md text\n");
    run("git add -A && git commit -q -m 'stop tracking png with LFS'", workDir);

    await new GitManager(workDir).push("origin", "main");

    expect(fs.existsSync(path.join(bareDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid))).toBe(true);
  });

  it("uploads for an rc tag on an unpublished commit, and leaves no tag behind when that fails", async () => {
    commitAsset();
    const oid = /oid sha256:([0-9a-f]{64})/.exec(run("git cat-file -p HEAD:art.png", workDir))?.[1] ?? "";
    const git = new GitManager(workDir);

    await git.createAndPushTag("v1.0.0-rc.1", "rc");
    expect(run("git tag --list", bareDir)).toContain("v1.0.0-rc.1");
    expect(fs.existsSync(path.join(bareDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid))).toBe(true);

    pointLfsAtDeadServer();
    commitAsset2();
    await expect(git.createAndPushTag("v1.0.0-rc.2", "rc")).rejects.toBeInstanceOf(LfsUploadError);
    expect(run("git tag --list", bareDir)).not.toContain("v1.0.0-rc.2");
    expect(run("git tag --list", workDir)).not.toContain("v1.0.0-rc.2");
  });

  it("pushes the ref when the branch has no LFS objects to upload, even with the LFS server down", async () => {
    pointLfsAtDeadServer();

    await new GitManager(workDir).push("origin", "main");

    expect(remoteTip()).toBe(run("git rev-parse HEAD", workDir).trim());
  });
});
