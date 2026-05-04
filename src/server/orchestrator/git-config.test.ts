import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { initGlobalGitConfig } from "./git-config.js";

describe("git-config: initGlobalGitConfig", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-config-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    delete process.env.GIT_EDITOR;
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets GIT_EDITOR=true so git rebase --continue does not try to open an editor", () => {
    initGlobalGitConfig(tmpDir);
    expect(process.env.GIT_EDITOR).toBe("true");
  });

  it("does not override an existing GIT_EDITOR setting", () => {
    process.env.GIT_EDITOR = "/usr/bin/nano";
    initGlobalGitConfig(tmpDir);
    expect(process.env.GIT_EDITOR).toBe("/usr/bin/nano");
  });

  it("regression: a real rebase --continue succeeds after init (no editor in env)", () => {
    // Reproduces the production bug: in the orchestrator container there is
    // no editor binary on PATH, so `git rebase --continue` would fail with
    // "cannot run editor". Verify that initGlobalGitConfig fixes this.
    initGlobalGitConfig(tmpDir);
    // initGlobalGitConfig sets GIT_EDITOR=true; explicitly clear PATH-based
    // editors to simulate the production container environment.
    delete process.env.EDITOR;

    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir);
    const env = {
      ...process.env,
      // Simulate the worst case: even if simple-git inherited a missing editor,
      // GIT_EDITOR=true (set by initGlobalGitConfig) wins over core.editor.
    };
    execSync("git init -q -b main", { cwd: repoDir, env });
    execSync("git config user.email t@t.com", { cwd: repoDir, env });
    execSync("git config user.name t", { cwd: repoDir, env });

    fs.writeFileSync(path.join(repoDir, "f.txt"), "v1\n");
    execSync("git add -A && git commit -q -m Initial", { cwd: repoDir, env });
    execSync("git checkout -q -b feature", { cwd: repoDir, env });
    fs.writeFileSync(path.join(repoDir, "f.txt"), "feature\n");
    execSync("git add -A && git commit -q -m Feature", { cwd: repoDir, env });
    execSync("git checkout -q main", { cwd: repoDir, env });
    fs.writeFileSync(path.join(repoDir, "f.txt"), "upstream\n");
    execSync("git add -A && git commit -q -m Upstream", { cwd: repoDir, env });
    execSync("git checkout -q feature", { cwd: repoDir, env });

    // Trigger the conflict.
    let rebaseFailed = false;
    try {
      execSync("git rebase main", { cwd: repoDir, env, stdio: "pipe" });
    } catch {
      rebaseFailed = true;
    }
    expect(rebaseFailed).toBe(true);

    // Resolve and continue — this is the step that fails in production
    // without the GIT_EDITOR=true fix.
    fs.writeFileSync(path.join(repoDir, "f.txt"), "merged\n");
    execSync("git add -A", { cwd: repoDir, env });
    execSync("git rebase --continue", { cwd: repoDir, env, stdio: "pipe" });

    // Verify rebase actually completed.
    const status = execSync("git status --porcelain=v2 --branch", {
      cwd: repoDir,
      env,
      encoding: "utf-8",
    });
    expect(status).toContain("# branch.head feature");
    // No rebase state directories should remain.
    expect(fs.existsSync(path.join(repoDir, ".git", "rebase-merge"))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, ".git", "rebase-apply"))).toBe(false);
  });
});
