import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import {
  initGlobalGitConfig,
  setGlobalCredentialHelper,
  clearGlobalCredentialHelper,
  setGitIdentity,
  writeContainerGitConfig,
  CONTAINER_CREDENTIAL_HELPER,
  FALLBACK_CONTAINER_GIT_IDENTITY,
  GLOBAL_CREDENTIAL_FILENAME,
} from "./git-config.js";

describe("git-config: initGlobalGitConfig", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;
  let origLcAll: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-config-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    origLcAll = process.env.LC_ALL;
    delete process.env.GIT_EDITOR;
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    if (origLcAll !== undefined) process.env.LC_ALL = origLcAll;
    else delete process.env.LC_ALL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pins LC_ALL=C so git's messages stay matchable", () => {
    process.env.LC_ALL = "fr_FR.UTF-8";
    initGlobalGitConfig(tmpDir);
    expect(process.env.LC_ALL).toBe("C");
  });

  it("reaches a child spawned with no explicit env — the way git is spawned", () => {
    // English output alone would pass on images without translations.
    process.env.LC_ALL = "fr_FR.UTF-8";
    initGlobalGitConfig(tmpDir);
    expect(execSync("printenv LC_ALL", { encoding: "utf-8" }).trim()).toBe("C");
  });

  describe("the global excludes file (planning#420)", () => {
    const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;
    const opened: string[] = [];

    afterEach(() => {
      for (const d of opened.splice(0)) {
        fs.chmodSync(d, 0o755);
        fs.rmSync(path.dirname(d), { recursive: true, force: true });
      }
      if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
    });

    function gitStderrUnderSealedHome(): string {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-home-"));
      fs.mkdirSync(path.join(home, ".config", "git"), { recursive: true });
      fs.chmodSync(path.join(home, ".config"), 0o000);
      opened.push(path.join(home, ".config"));
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-repo-"));
      execSync("git init -q .", { cwd: repo });
      const run = spawnSync("git", ["status", "--porcelain"], {
        cwd: repo,
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "",
        },
      });
      fs.rmSync(repo, { recursive: true, force: true });
      return run.stderr;
    }

    it("silences the /root/.config/git/ignore warning that buried the real error", () => {
      if (process.getuid?.() === 0) return; // Root can read mode 0000.
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";

      process.env.GIT_CONFIG_GLOBAL = path.join(tmpDir, "empty.gitconfig");
      fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
      expect(gitStderrUnderSealedHome()).toMatch(/unable to access .*git\/ignore/);

      initGlobalGitConfig(tmpDir);

      expect(gitStderrUnderSealedHome()).not.toMatch(/unable to access/);
    });

    it("points the key at a file every uid can reach, and keeps an operator's patterns", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      initGlobalGitConfig(tmpDir);

      const target = execSync("git config --global core.excludesFile", { encoding: "utf-8" }).trim();
      expect(target).toBe(path.join(tmpDir, "gitignore-global"));
      expect(fs.statSync(target).mode & 0o777).toBe(0o644);

      fs.writeFileSync(target, "*.local\n");
      initGlobalGitConfig(tmpDir);
      expect(fs.readFileSync(target, "utf-8")).toBe("*.local\n");
    });

    it("leaves an operator's own core.excludesFile exactly where it points", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      const theirs = path.join(tmpDir, "operator-excludes");
      fs.writeFileSync(theirs, "dist/\n");
      process.env.GIT_CONFIG_GLOBAL = path.join(tmpDir, ".gitconfig");
      execSync(`git config --global core.excludesFile ${theirs}`);

      initGlobalGitConfig(tmpDir);

      expect(execSync("git config --global core.excludesFile", { encoding: "utf-8" }).trim())
        .toBe(theirs);
      expect(fs.existsSync(path.join(tmpDir, "gitignore-global"))).toBe(false);
    });

    it("leaves a deployment with no worker uid to its own global excludes", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      initGlobalGitConfig(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, "gitignore-global"))).toBe(false);
      expect(
        spawnSync("git", ["config", "--global", "core.excludesFile"], { encoding: "utf-8" }).status,
      ).not.toBe(0);
    });
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
    initGlobalGitConfig(tmpDir);
    delete process.env.EDITOR;

    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir);
    const env = {
      ...process.env,
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

    let rebaseFailed = false;
    try {
      execSync("git rebase main", { cwd: repoDir, env, stdio: "pipe" });
    } catch {
      rebaseFailed = true;
    }
    expect(rebaseFailed).toBe(true);

    fs.writeFileSync(path.join(repoDir, "f.txt"), "merged\n");
    execSync("git add -A", { cwd: repoDir, env });
    execSync("git rebase --continue", { cwd: repoDir, env, stdio: "pipe" });

    const status = execSync("git status --porcelain=v2 --branch", {
      cwd: repoDir,
      env,
      encoding: "utf-8",
    });
    expect(status).toContain("# branch.head feature");
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

  it("keeps the token OUT of the gitconfig and in a 0600 file beside it (docs/266-orchestrator-git-trust-boundary E3)", () => {
    setGlobalCredentialHelper("ghp_some_token_value");

    const configPath = process.env.GIT_CONFIG_GLOBAL!;
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("ghp_some_token_value");

    const helper = execSync("git config --global credential.helper", { encoding: "utf-8" }).trim();
    expect(helper).not.toContain("ghp_some_token_value");

    const credPath = path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME);
    expect(helper).toContain(credPath);
    const contents = fs.readFileSync(credPath, "utf-8");
    expect(contents).toContain("password=ghp_some_token_value");
    expect(contents).toContain("username=x-access-token");
    expect(fs.statSync(credPath).mode & 0o777).toBe(0o600);
  });

  it("repairs the shared config to 0644 — readable by the worker, writable by root alone", () => {
    const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    try {
      const configPath = process.env.GIT_CONFIG_GLOBAL!;
      setGitIdentity("Test", "test@test.com");
      fs.chmodSync(configPath, 0o600);
      setGlobalCredentialHelper("ghp_some_token_value");
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o644);
    } finally {
      if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
    }
  });

  it("says so, loudly, when the credential file is missing rather than degrading silently", () => {
    setGlobalCredentialHelper("some-token");
    fs.rmSync(path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME));
    const out = execSync(
      "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>&1 || true",
      { encoding: "utf-8", shell: "/bin/sh", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    expect(out).toContain("git credential file missing");
  });

  it("a helper whose credential file is unreadable answers nothing rather than failing git", () => {
    setGlobalCredentialHelper("unreachable-token");
    const credPath = path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME);
    fs.chmodSync(credPath, 0o000);
    try {
      const out = execSync("git config --get user.email || true", { encoding: "utf-8", shell: "/bin/sh" });
      expect(out).not.toContain("unreachable-token");
      const filled = execSync(
        "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>&1 || true",
        { encoding: "utf-8", shell: "/bin/sh", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
      expect(filled).not.toContain("unreachable-token");
    } finally {
      fs.chmodSync(credPath, 0o600);
    }
  });

  it("a fresh workspace (no local helper) authenticates against a private remote via the global helper", () => {
    const captureDir = path.join(tmpDir, "capture");
    fs.mkdirSync(captureDir);
    setGlobalCredentialHelper("the-test-token");

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
    let cleared = false;
    try {
      execSync("git config --global credential.helper", { stdio: "pipe" });
    } catch {
      cleared = true;
    }
    expect(cleared).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME))).toBe(false);
    expect(() => { clearGlobalCredentialHelper(); }).not.toThrow();
  });

  it("setGlobalCredentialHelper twice overwrites — no stale token left anywhere", () => {
    setGlobalCredentialHelper("old-token");
    setGlobalCredentialHelper("new-token");
    const credPath = path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME);
    const contents = fs.readFileSync(credPath, "utf-8");
    expect(contents).toContain("new-token");
    expect(contents).not.toContain("old-token");
    const config = fs.readFileSync(process.env.GIT_CONFIG_GLOBAL!, "utf-8");
    expect(config).not.toContain("old-token");
    expect(config).not.toContain("new-token");
  });

  it("refuses an empty credential rather than writing an unusable one", () => {
    expect(() => { setGlobalCredentialHelper("   "); }).toThrow(/empty GitHub credential/);
    expect(fs.existsSync(path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME))).toBe(false);
  });

  it("warns — but still installs — a token too short to be a GitHub token", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setGlobalCredentialHelper("ghp_x");
      const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(message).toContain("5 characters");
      expect(message).not.toContain("ghp_x");
    } finally {
      warn.mockRestore();
    }
    const contents = fs.readFileSync(path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME), "utf-8");
    expect(contents).toContain("password=ghp_x");
  });
});

describe("git-config: credential permission state (planning#387)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-modes-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the credentials directory 0711 — traversable, never listable", () => {
    const dir = path.join(tmpDir, "creds");
    initGlobalGitConfig(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o711);
  });

  it("repairs a credentials directory an older build left at 0755", () => {
    const dir = path.join(tmpDir, "creds");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    initGlobalGitConfig(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o711);
  });

  it("repairs a credential file left at 0644 back to 0600 on the next write", () => {
    initGlobalGitConfig(tmpDir);
    setGlobalCredentialHelper("ghp_mode_repair_token");
    const credPath = path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME);
    expect(fs.statSync(credPath).mode & 0o777).toBe(0o600);

    fs.chmodSync(credPath, 0o644);
    setGlobalCredentialHelper("ghp_mode_repair_token");
    expect(fs.statSync(credPath).mode & 0o777).toBe(0o600);
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
    setGlobalCredentialHelper("ghp_super_secret_token");
    setGitIdentity("Ada Lovelace", "ada@example.com");

    const dest = path.join(tmpDir, "container", ".gitconfig");
    writeContainerGitConfig(dest);

    const contents = fs.readFileSync(dest, "utf-8");
    expect(contents).not.toContain("ghp_super_secret_token");
    expect(contents).toContain("Ada Lovelace");
    expect(contents).toContain("ada@example.com");

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

  describe("identity floor — the container can always commit", () => {
    it("falls back to a placeholder identity when the user has configured none", () => {
      const dest = path.join(tmpDir, "container", ".gitconfig");
      writeContainerGitConfig(dest);

      const read = (key: string) =>
        execSync(`git config --file ${dest} ${key}`, { encoding: "utf-8" }).trim();
      expect(read("user.name")).toBe(FALLBACK_CONTAINER_GIT_IDENTITY.name);
      expect(read("user.email")).toBe(FALLBACK_CONTAINER_GIT_IDENTITY.email);
      expect(FALLBACK_CONTAINER_GIT_IDENTITY.email).toMatch(/\.invalid$/);
    });

    it("a real identity always wins, and overrides the fallback retroactively", () => {
      const dest = path.join(tmpDir, "container", ".gitconfig");
      writeContainerGitConfig(dest);
      expect(
        execSync(`git config --file ${dest} user.name`, { encoding: "utf-8" }).trim(),
      ).toBe(FALLBACK_CONTAINER_GIT_IDENTITY.name);

      setGitIdentity("Ada Lovelace", "ada@example.com");
      writeContainerGitConfig(dest);

      const contents = fs.readFileSync(dest, "utf-8");
      expect(contents).toContain("Ada Lovelace");
      expect(contents).toContain("ada@example.com");
      expect(contents).not.toContain(FALLBACK_CONTAINER_GIT_IDENTITY.name);
    });

    it("end-to-end: a commit succeeds in a repo using only this gitconfig", () => {
      const dest = path.join(tmpDir, "container", ".gitconfig");
      writeContainerGitConfig(dest);

      const repo = path.join(tmpDir, "sandbox-clone");
      fs.mkdirSync(repo, { recursive: true });
      // Empty identity variables override the config; remove them instead.
      const SCRUBBED = new Set([
        "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL",
      ]);
      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUBBED.has(k))),
        GIT_CONFIG_GLOBAL: dest,
        GIT_CONFIG_SYSTEM: "/dev/null",
      };
      const run = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf-8", env });
      run("git init -q -b main");
      fs.writeFileSync(path.join(repo, "notes.md"), "sandbox work\n");
      run("git add -A");
      run('git commit -qm "the agent commits its own work"');

      expect(run("git log --format=%an").trim()).toBe(FALLBACK_CONTAINER_GIT_IDENTITY.name);
    });
  });

  it("rewrites fresh each call — no stale token survives a regeneration", () => {
    const dest = path.join(tmpDir, "container", ".gitconfig");
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

describe("git-config: no safe.directory is granted (docs/266 E2, planning#410)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origUid: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-safedir-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origUid = process.env.SHIPIT_SESSION_WORKER_UID;
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origUid !== undefined) process.env.SHIPIT_SESSION_WORKER_UID = origUid;
    else delete process.env.SHIPIT_SESSION_WORKER_UID;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const readSafeDirs = (): string[] => {
    try {
      return execSync("git config --global --get-all safe.directory", { encoding: "utf-8" })
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  it("writes none when SHIPIT_SESSION_WORKER_UID is set", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    initGlobalGitConfig(tmpDir);
    expect(readSafeDirs()).toEqual([]);
  });

  it("writes none when SHIPIT_SESSION_WORKER_UID is unset (root worker)", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    initGlobalGitConfig(tmpDir);
    expect(readSafeDirs()).toEqual([]);
  });

  it("removes a grant an older build persisted", () => {
    const configPath = path.join(tmpDir, ".gitconfig");
    process.env.GIT_CONFIG_GLOBAL = configPath;
    execSync(`git config --file ${configPath} --add safe.directory "*"`);
    expect(readSafeDirs()).toContain("*");

    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    initGlobalGitConfig(tmpDir);
    expect(readSafeDirs()).toEqual([]);
  });

  it("removes every entry, not just the first, and not just `*`", () => {
    const configPath = path.join(tmpDir, ".gitconfig");
    process.env.GIT_CONFIG_GLOBAL = configPath;
    execSync(`git config --file ${configPath} --add safe.directory "*"`);
    execSync(`git config --file ${configPath} --add safe.directory /workspace`);
    expect(readSafeDirs()).toHaveLength(2);

    initGlobalGitConfig(tmpDir);
    expect(readSafeDirs()).toEqual([]);
  });

  it("is idempotent — repeated init leaves the key absent and does not throw", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    initGlobalGitConfig(tmpDir);
    initGlobalGitConfig(tmpDir);
    expect(readSafeDirs()).toEqual([]);
  });
});

describe("git-config: GitHub SSH→HTTPS rewrite (docs/200)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-insteadof-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const readInsteadOf = (): string[] => {
    try {
      return execSync('git config --global --get-all "url.https://github.com/.insteadOf"', {
        encoding: "utf-8",
      })
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  it("rewrites both SCP-style and ssh:// github.com URLs to HTTPS", () => {
    initGlobalGitConfig(tmpDir);
    const vals = readInsteadOf();
    expect(vals).toContain("git@github.com:");
    expect(vals).toContain("ssh://git@github.com/");
  });

  it("applies regardless of SHIPIT_SESSION_WORKER_UID (unconditional)", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    initGlobalGitConfig(tmpDir);
    expect(readInsteadOf()).toContain("git@github.com:");
  });

  it("is idempotent — repeated init does not duplicate entries", () => {
    initGlobalGitConfig(tmpDir);
    initGlobalGitConfig(tmpDir);
    const vals = readInsteadOf();
    expect(vals.filter((v) => v === "git@github.com:")).toHaveLength(1);
    expect(vals.filter((v) => v === "ssh://git@github.com/")).toHaveLength(1);
  });

  it("functionally rewrites an SSH remote to HTTPS at git-resolution time", () => {
    initGlobalGitConfig(tmpDir);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-insteadof-repo-"));
    try {
      execSync("git init -q", { cwd: repo });
      execSync("git remote add origin git@github.com:nikzlabs/shipit.git", { cwd: repo });
      const resolved = execSync("git ls-remote --get-url origin", { cwd: repo, encoding: "utf-8" }).trim();
      expect(resolved).toBe("https://github.com/nikzlabs/shipit.git");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
