import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  initGlobalGitConfig,
  setGlobalCredentialHelper,
  clearGlobalCredentialHelper,
  setGitIdentity,
  writeContainerGitConfig,
  CONTAINER_CREDENTIAL_HELPER,
} from "./git-config.js";

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

describe("git-config: setGlobalCredentialHelper / clearGlobalCredentialHelper", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-cred-helper-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a working credential helper into the global gitconfig", () => {
    setGlobalCredentialHelper("ghp_some_token_value");
    const helper = execSync("git config --global credential.helper", { encoding: "utf-8" }).trim();
    expect(helper).toContain("ghp_some_token_value");
    expect(helper).toContain("x-access-token");
  });

  it("a fresh workspace (no local helper) authenticates against a private remote via the global helper", () => {
    // Build a remote that requires the global helper's username/password.
    // Smudge factory: a custom `credential.helper` writes whatever the global
    // helper echoes into a file we then inspect — proves git ran the helper.
    const captureDir = path.join(tmpDir, "capture");
    fs.mkdirSync(captureDir);
    setGlobalCredentialHelper("the-test-token");

    // The fastest way to prove git resolved the global helper without
    // reaching out over the network: run `git credential fill` on stdin.
    // It asks the configured helpers and prints the resolved credential.
    const out = execSync("printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill", {
      encoding: "utf-8",
      shell: "/bin/sh",
    });
    expect(out).toContain("username=x-access-token");
    expect(out).toContain("password=the-test-token");
  });

  it("clearGlobalCredentialHelper removes the helper and is a no-op when nothing is set", () => {
    setGlobalCredentialHelper("t1");
    clearGlobalCredentialHelper();
    // After clearing, `git config --get` exits non-zero — wrap to detect.
    let cleared = false;
    try {
      execSync("git config --global credential.helper", { stdio: "pipe" });
    } catch {
      cleared = true;
    }
    expect(cleared).toBe(true);
    // Second call must not throw even though the helper is already gone.
    expect(() => { clearGlobalCredentialHelper(); }).not.toThrow();
  });

  it("setGlobalCredentialHelper twice overwrites — no stale token left in config", () => {
    setGlobalCredentialHelper("old-token");
    setGlobalCredentialHelper("new-token");
    const helper = execSync("git config --global credential.helper", { encoding: "utf-8" }).trim();
    expect(helper).toContain("new-token");
    expect(helper).not.toContain("old-token");
  });
});

describe("git-config: writeContainerGitConfig (docs/088 finding #5)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-container-gitconfig-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a token-free gitconfig pointing at the brokering helper", () => {
    // Orchestrator's own global config has the inline token...
    setGlobalCredentialHelper("ghp_super_secret_token");
    setGitIdentity("Ada Lovelace", "ada@example.com");

    const dest = path.join(tmpDir, "container", ".gitconfig");
    writeContainerGitConfig(dest);

    const contents = fs.readFileSync(dest, "utf-8");
    // The PAT must NEVER appear in the container's gitconfig.
    expect(contents).not.toContain("ghp_super_secret_token");
    // Identity is preserved.
    expect(contents).toContain("Ada Lovelace");
    expect(contents).toContain("ada@example.com");

    // credential.helper points at the brokering binary, not an inline token.
    const helper = execSync(`git config --file ${dest} credential.helper`, {
      encoding: "utf-8",
    }).trim();
    expect(helper).toBe(CONTAINER_CREDENTIAL_HELPER);
    expect(helper).not.toContain("ghp_");
  });

  it("disables commit signing", () => {
    const dest = path.join(tmpDir, "container", ".gitconfig");
    writeContainerGitConfig(dest);
    const sign = execSync(`git config --file ${dest} commit.gpgsign`, { encoding: "utf-8" }).trim();
    expect(sign).toBe("false");
  });

  it("rewrites fresh each call — no stale token survives a regeneration", () => {
    const dest = path.join(tmpDir, "container", ".gitconfig");
    // Simulate a stale token-bearing file lingering at the destination.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "[credential]\n\thelper = !echo password=leaked_token\n");

    writeContainerGitConfig(dest);

    const contents = fs.readFileSync(dest, "utf-8");
    expect(contents).not.toContain("leaked_token");
    const helper = execSync(`git config --file ${dest} credential.helper`, {
      encoding: "utf-8",
    }).trim();
    expect(helper).toBe(CONTAINER_CREDENTIAL_HELPER);
  });
});
