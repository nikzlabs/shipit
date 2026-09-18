import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { pushLfsObjects, lfsDeclarationGrepArgs } from "./git-lfs-push.js";
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
    const outcome = await pushLfsObjects(safeSimpleGit(workDir), "origin", "main");
    expect(outcome.status).toBe("not-an-lfs-repo");
  });

  it("ignores a `.gitattributes` that declares no LFS filter", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.md text eol=lf\n");
    run("git add -A && git commit -m attrs", workDir);

    const outcome = await pushLfsObjects(safeSimpleGit(workDir), "origin", "main");
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

    const outcome = await pushLfsObjects(safeSimpleGit(workDir), "origin", "main");
    expect(outcome.status).not.toBe("not-an-lfs-repo");
  });

  it("asks about the branch being published, not about HEAD", async () => {
    run("git checkout -q -b assets", workDir);
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);
    run("git checkout -q main", workDir);

    expect((await pushLfsObjects(safeSimpleGit(workDir), "origin", "main")).status)
      .toBe("not-an-lfs-repo");
    expect((await pushLfsObjects(safeSimpleGit(workDir), "origin", "assets")).status)
      .not.toBe("not-an-lfs-repo");
  });

  it("falls back to HEAD when the named branch does not resolve", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);

    expect((await pushLfsObjects(safeSimpleGit(workDir), "origin", "no-such-branch")).status)
      .not.toBe("not-an-lfs-repo");
  });

  it("reports a failed upload instead of throwing", async () => {
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    run("git add -A && git commit -m attrs", workDir);
    const outcome = await pushLfsObjects(safeSimpleGit(workDir), "nope", "main");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.detail).not.toBe("");
  });

  it("answers 'no' rather than throwing on a repo with no commits", async () => {
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    run("git init -b main", empty);
    const outcome = await pushLfsObjects(safeSimpleGit(empty), "origin", "main");
    expect(outcome.status).toBe("not-an-lfs-repo");
  });

  it("scopes the detection grep to the ref it is given", () => {
    expect(lfsDeclarationGrepArgs()).toContain("HEAD");
    expect(lfsDeclarationGrepArgs("refs/heads/other")).toContain("refs/heads/other");
    expect(lfsDeclarationGrepArgs()).toContain("*.gitattributes");
  });
});

describe("GitManager.push with LFS content it cannot upload", () => {
  let root: string;
  let bareDir: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

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
    run("git add -A && git commit -m init", workDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("still lands the ref push, and says so in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await new GitManager(workDir).push("origin", "main");

    expect(run("git rev-parse refs/heads/main", bareDir).trim())
      .toBe(run("git rev-parse HEAD", workDir).trim());

    const lines = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0] ?? "") + String(c[1] ?? ""));
    expect(lines.some((l) => /lfs/i.test(l))).toBe(true);
  });
});
