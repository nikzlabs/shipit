import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitManager } from "./git.js";
import {
  HOOKS_DISABLED_PATH,
  HOOKS_DISABLED_CONFIG,
  GIT_HOOKS_DISABLED_ARGS,
  gitArgsWithHooksDisabled,
  safeSimpleGit,
} from "./git-hooks-guard.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

const HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
] as const;

describe("git hooks guard", () => {
  let tmpDir: string;
  let markerFile: string;
  let origGitConfigGlobal: string | undefined;

  // Mark execution without failing git: successful commands can still run unsafe hooks.
  function plantHooks(repoDir: string): void {
    const hooksDir = path.join(repoDir, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const name of HOOK_NAMES) {
      const file = path.join(hooksDir, name);
      fs.writeFileSync(file, `#!/bin/sh\necho ${name} >> ${JSON.stringify(markerFile)}\nexit 0\n`);
      fs.chmodSync(file, 0o755);
    }
  }

  function firedHooks(): string[] {
    if (!fs.existsSync(markerFile)) return [];
    return [...new Set(fs.readFileSync(markerFile, "utf-8").split("\n").filter(Boolean))].sort();
  }

  function write(file: string, contents: string): void {
    fs.writeFileSync(path.join(tmpDir, file), contents);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-hooks-guard-"));
    markerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shipit-hooks-marker-")), "fired.txt");
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(markerFile), { recursive: true, force: true });
  });

  it("control: the planted hooks really do fire under unguarded git", () => {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });
    plantHooks(tmpDir);
    write("a.txt", "one");
    execFileSync("git", ["add", "-A"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "one"], { cwd: tmpDir, stdio: "ignore" });

    expect(firedHooks()).toEqual(
      expect.arrayContaining(["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction"]),
    );
  });

  it("GitManager.autoCommit does not run a repository pre-commit hook", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    plantHooks(tmpDir);

    write("payload.txt", "agent output");
    const result = await git.autoCommit("a turn");

    expect(result.commitHash).toBeTruthy();
    expect(firedHooks()).toEqual([]);
  });

  it("GitManager.commitPaths does not run a repository pre-commit hook", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    plantHooks(tmpDir);

    write("skill.md", "installed");
    const hash = await git.commitPaths(["skill.md"], "install a skill");

    expect(hash).toBeTruthy();
    expect(firedHooks()).toEqual([]);
  });

  it("GitManager.checkoutNewBranch does not run a repository post-checkout hook", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    plantHooks(tmpDir);

    await git.checkoutNewBranch("shipit/abc123");

    expect(await git.getCurrentBranch()).toBe("shipit/abc123");
    expect(firedHooks()).toEqual([]);
  });

  it("GitManager.merge does not run a repository post-merge / pre-merge-commit hook", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    write("base.txt", "base");
    await git.autoCommit("base");

    await git.checkoutNewBranch("side");
    write("side.txt", "side");
    await git.autoCommit("side");
    await git.checkoutNewBranch("trunk-work");
    write("trunk.txt", "trunk");
    await git.autoCommit("trunk");

    plantHooks(tmpDir);
    const merged = await git.merge("side");

    expect(merged.success).toBe(true);
    expect(firedHooks()).toEqual([]);
  });

  it("GitManager.rebase does not run a repository pre-rebase / post-rewrite hook", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    write("base.txt", "base");
    await git.autoCommit("base");
    const base = await git.getCurrentBranch();

    await git.checkoutNewBranch("feature");
    write("feature.txt", "feature");
    await git.autoCommit("feature");

    await git.rollback(base);
    await git.checkoutNewBranch("moved-base");
    write("other.txt", "other");
    await git.autoCommit("other");
    const movedBase = await git.getHeadHash();

    await git.renameBranch("feature", "feature");
    plantHooks(tmpDir);
    const rebased = await git.rebase("feature");

    expect(rebased.status).toBe("clean");
    expect(movedBase).toBeTruthy();
    expect(firedHooks()).toEqual([]);
  });

  it("GitManager.push does not run a repository pre-push hook", async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-hooks-remote-"));
    try {
      execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote, stdio: "ignore" });

      const git = new GitManager(tmpDir);
      await git.init();
      write("a.txt", "one");
      await git.autoCommit("one");
      await git.addRemote("origin", remote);

      plantHooks(tmpDir);
      await git.push("origin");

      expect(firedHooks()).toEqual([]);
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  it("a repository-local core.hooksPath cannot re-enable hooks", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    plantHooks(tmpDir);
    execFileSync("git", ["config", "core.hooksPath", path.join(tmpDir, ".git", "hooks")], {
      cwd: tmpDir,
      stdio: "ignore",
    });

    write("payload.txt", "agent output");
    const result = await git.autoCommit("a turn");

    expect(result.commitHash).toBeTruthy();
    expect(firedHooks()).toEqual([]);
  });

  it("safeSimpleGit disables hooks for an arbitrary command", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    plantHooks(tmpDir);

    write("x.txt", "x");
    const sg = safeSimpleGit(tmpDir);
    await sg.add("-A");
    await sg.commit("via safeSimpleGit");

    expect(firedHooks()).toEqual([]);
  });

  it("gitArgsWithHooksDisabled disables hooks for a raw git spawn", () => {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });
    plantHooks(tmpDir);
    write("a.txt", "one");

    execFileSync("git", gitArgsWithHooksDisabled(["add", "-A"]), { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", gitArgsWithHooksDisabled(["commit", "-m", "one"]), { cwd: tmpDir, stdio: "ignore" });

    expect(firedHooks()).toEqual([]);
  });
});

describe("git hooks guard: exposed shapes", () => {
  it("exposes the override in the shapes callers need", () => {
    expect(HOOKS_DISABLED_CONFIG).toBe(`core.hooksPath=${HOOKS_DISABLED_PATH}`);
    expect([...GIT_HOOKS_DISABLED_ARGS]).toEqual(["-c", HOOKS_DISABLED_CONFIG]);
    expect(gitArgsWithHooksDisabled(["status"])).toEqual(["-c", HOOKS_DISABLED_CONFIG, "status"]);
  });

  it("keeps a caller's own simple-git options, including other unsafe opt-ins", () => {
    const git = safeSimpleGit(undefined, {
      unsafe: { allowUnsafeConfigPaths: true },
      config: ["user.name=Someone"],
    });
    expect(git).toBeTruthy();
  });
});
