import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  FALLBACK_CONTAINER_GIT_IDENTITY,
  gitStrictOwnership,
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

  /**
   * docs/266 / planning#407 — `shared/git.ts` classifies the two
   * unreadable-workspace states by matching git's ENGLISH stderr, because
   * simple-git's `GitError` carries no exit code. Under a translated locale
   * those matches stop firing and a turn commits short in silence again.
   *
   * The process environment is the only place that reaches every
   * orchestrator-side git: simple-git's `env()` ASSIGNS (so a caller chaining
   * it discards an override) and forwarding `process.env` to make it stick trips
   * `blockUnsafeOperationsPlugin` on the `GIT_CONFIG_GLOBAL` set here.
   *
   * What this test canNOT fail on: whether git's translations are installed in
   * this image at all. It pins the intent — the language is chosen, not
   * inherited — not a reproduction of a translated failure.
   */
  it("pins LC_ALL=C so git's messages stay matchable", () => {
    process.env.LC_ALL = "fr_FR.UTF-8";
    initGlobalGitConfig(tmpDir);
    expect(process.env.LC_ALL).toBe("C");
  });

  it("reaches a child spawned with no explicit env — the way git is spawned", () => {
    // The mechanism, not the translation: simple-git's default executor passes
    // `env: null`, so the child inherits this process's environment. A test that
    // asserted English output would pass on an image with no translations
    // installed whether or not anything was pinned.
    process.env.LC_ALL = "fr_FR.UTF-8";
    initGlobalGitConfig(tmpDir);
    expect(execSync("printenv LC_ALL", { encoding: "utf-8" }).trim()).toBe("C");
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

  it("keeps the token OUT of the gitconfig and in a 0600 file beside it (docs/266-orchestrator-git-trust-boundary E3)", () => {
    setGlobalCredentialHelper("ghp_some_token_value");

    // The config is shared with the session-worker uid so a dropped-uid git can
    // read identity and `url.insteadOf` from it (E1). That sharing is only safe
    // while the config holds no secret — this is the assertion that keeps it so.
    const configPath = process.env.GIT_CONFIG_GLOBAL!;
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("ghp_some_token_value");

    const helper = execSync("git config --global credential.helper", { encoding: "utf-8" }).trim();
    expect(helper).not.toContain("ghp_some_token_value");

    const credPath = path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME);
    expect(helper).toContain(credPath);
    const contents = fs.readFileSync(credPath, "utf-8");
    expect(contents).toContain("password=ghp_some_token_value");
    expect(contents).toContain("username=x-access-token");
    // Root-only. The whole point is that the worker uid cannot read it; the
    // mode is the part of that a test running as one uid can check.
    expect(fs.statSync(credPath).mode & 0o777).toBe(0o600);
  });

  it("repairs the shared config to 0644 — readable by the worker, writable by root alone", () => {
    // The config is READ by the dropped-uid git (identity, `url.insteadOf`) and
    // by root-side git on the bare cache and `/opt/shipit`. E1 handed it to the
    // worker uid at 0600 because it carried the PAT; with the secret gone that
    // ownership is the sharper problem — owning a file is permission to WRITE
    // it, and a `credential.helper = !<attacker>` written here executes as ROOT
    // on the next bare-cache fetch. (Review finding on PR #2341.)
    //
    // The sharing path is gated on `SHIPIT_SESSION_WORKER_UID`, so the variable
    // has to be set or this test proves nothing but the runner's umask — and
    // the file is put into E1's 0600 shape first, so the assertion is on the
    // REPAIR rather than on a mode that happened to be right already.
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
    // Unreadable is the DESIGNED state for a dropped-uid git and stays silent.
    // Missing is a real fault on the root path — a wiped volume, a failed first
    // write — and would otherwise surface only as "could not read Username".
    setGlobalCredentialHelper("some-token");
    fs.rmSync(path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME));
    const out = execSync(
      "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>&1 || true",
      { encoding: "utf-8", shell: "/bin/sh", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    expect(out).toContain("git credential file missing");
  });

  it("a helper whose credential file is unreadable answers nothing rather than failing git", () => {
    // The dropped-uid case, approximated with a mode the current uid cannot
    // read either: the helper must go quiet, not break the git invocation. An
    // unreadable `include.path` is a hard `fatal:` on every git command, which
    // is exactly why the token is NOT pulled in that way.
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
    // docs/266-orchestrator-git-trust-boundary E3 — clearing must remove the token FILE too. Unsetting the key
    // alone would leave a revoked PAT on disk until the next one overwrote it.
    expect(fs.existsSync(path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME))).toBe(false);
    // Second call must not throw even though the helper is already gone.
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

  /**
   * #2432 — a credential that cannot authenticate must say so here, not two
   * pushes later as "remote: Invalid username or token" with nothing local to
   * explain it. Empty throws (no caller can reach it with a bug-free path);
   * short only warns, because a length guess must never be able to lock a real
   * token out.
   */
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
      // Never the value itself — this line goes to the orchestrator log.
      expect(message).not.toContain("ghp_x");
    } finally {
      warn.mockRestore();
    }
    const contents = fs.readFileSync(path.join(tmpDir, GLOBAL_CREDENTIAL_FILENAME), "utf-8");
    expect(contents).toContain("password=ghp_x");
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

  // An `ops` / `sandbox` agent's own commits are the only commits those
  // sessions get — ShipIt does not auto-commit them (`auto-commit-gate.ts`) —
  // and `git commit` HARD-FAILS with no identity. A sandbox is the worst case:
  // repo-less by design and creatable with `capabilities.git` off, so connecting
  // GitHub (the usual way an identity appears) is not part of its flow.
  describe("identity floor — the container can always commit", () => {
    it("falls back to a placeholder identity when the user has configured none", () => {
      const dest = path.join(tmpDir, "container", ".gitconfig");
      writeContainerGitConfig(dest);

      const read = (key: string) =>
        execSync(`git config --file ${dest} ${key}`, { encoding: "utf-8" }).trim();
      expect(read("user.name")).toBe(FALLBACK_CONTAINER_GIT_IDENTITY.name);
      expect(read("user.email")).toBe(FALLBACK_CONTAINER_GIT_IDENTITY.email);
      // RFC 2606 reserved TLD — can never reach a real mailbox.
      expect(FALLBACK_CONTAINER_GIT_IDENTITY.email).toMatch(/\.invalid$/);
    });

    it("a real identity always wins, and overrides the fallback retroactively", () => {
      const dest = path.join(tmpDir, "container", ".gitconfig");
      // Container provisioned before the user connected GitHub…
      writeContainerGitConfig(dest);
      expect(
        execSync(`git config --file ${dest} user.name`, { encoding: "utf-8" }).trim(),
      ).toBe(FALLBACK_CONTAINER_GIT_IDENTITY.name);

      // …then the identity is set and the file is regenerated (which is what
      // `provisionAgentCredentialsFromRoot` does on the next provision).
      setGitIdentity("Ada Lovelace", "ada@example.com");
      writeContainerGitConfig(dest);

      const contents = fs.readFileSync(dest, "utf-8");
      expect(contents).toContain("Ada Lovelace");
      expect(contents).toContain("ada@example.com");
      expect(contents).not.toContain(FALLBACK_CONTAINER_GIT_IDENTITY.name);
    });

    it("end-to-end: a commit succeeds in a repo using only this gitconfig", () => {
      // The actual failure being prevented — without an identity this is
      // "Author identity unknown ... fatal: unable to auto-detect email address".
      const dest = path.join(tmpDir, "container", ".gitconfig");
      writeContainerGitConfig(dest);

      const repo = path.join(tmpDir, "sandbox-clone");
      fs.mkdirSync(repo, { recursive: true });
      // Scrub the ambient identity so the config under test is the only source.
      // The vars must be DELETED, not set to "" — an empty `GIT_AUTHOR_NAME`
      // overrides the config and fails with "empty ident name" instead of
      // falling through to it.
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

// docs/150 §7 addendum — the planning#33 activation blocker. When the session
// worker runs as an unprivileged uid, an orchestrator git that RAN AS ROOT over
// a worker-owned worktree was refused with "detected dubious ownership" unless
// `safe.directory` was configured in the (trusted) global git config.
//
// planning#412 — stated in the past tense because since
// docs/266-orchestrator-git-trust-boundary E1 a correct call site drops to the
// tree's owner and never meets that refusal. What `safe.directory=*` still
// suppresses is the refusal on an INCORRECT site — one that failed to drop and
// so is still root against a tree untrusted code can write. That is why arming
// `SHIPIT_GIT_STRICT_OWNERSHIP` (which removes the `*`) is the point of the
// gating these tests pin; see `git-config.ts`'s own docstring.
describe("git-config: safe.directory gating (planning#33)", () => {
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

  // initGlobalGitConfig points GIT_CONFIG_GLOBAL at tmpDir/.gitconfig, so a
  // plain `git config --global` reads back the file it just wrote.
  const readSafeDirs = (): string[] => {
    try {
      return execSync("git config --global --get-all safe.directory", { encoding: "utf-8" })
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return []; // key absent → git exits non-zero
    }
  };

  it("adds safe.directory=* when SHIPIT_SESSION_WORKER_UID is set", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    initGlobalGitConfig(tmpDir);
    expect(readSafeDirs()).toContain("*");
  });

  it("does NOT add safe.directory when the flag is unset (legacy root worker)", () => {
    delete process.env.SHIPIT_SESSION_WORKER_UID;
    initGlobalGitConfig(tmpDir);
    expect(readSafeDirs()).not.toContain("*");
  });

  it("is idempotent — repeated init does not duplicate the entry", () => {
    process.env.SHIPIT_SESSION_WORKER_UID = "1000";
    initGlobalGitConfig(tmpDir);
    initGlobalGitConfig(tmpDir);
    expect(readSafeDirs().filter((d) => d === "*")).toHaveLength(1);
  });

  // docs/266-orchestrator-git-trust-boundary E2 (planning#403) — the fail-closed half. With the switch armed the
  // `*` is gone, so a call site that failed to drop to the tree's owner is
  // refused by git instead of running as root against a tree untrusted code can
  // write (req 7).
  describe("SHIPIT_GIT_STRICT_OWNERSHIP", () => {
    let origStrict: string | undefined;

    beforeEach(() => {
      origStrict = process.env.SHIPIT_GIT_STRICT_OWNERSHIP;
    });

    afterEach(() => {
      if (origStrict !== undefined) process.env.SHIPIT_GIT_STRICT_OWNERSHIP = origStrict;
      else delete process.env.SHIPIT_GIT_STRICT_OWNERSHIP;
    });

    it("writes no safe.directory when armed, even with a worker uid set", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      process.env.SHIPIT_GIT_STRICT_OWNERSHIP = "1";
      initGlobalGitConfig(tmpDir);
      expect(readSafeDirs()).toEqual([]);
    });

    // The config file lives in the persistent credentials volume, so arming the
    // switch on a deployment that has been running is the ONLY case that
    // matters in production — and it is the one a plain "stop writing it" would
    // silently get wrong.
    it("removes an entry an earlier boot wrote", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      initGlobalGitConfig(tmpDir);
      expect(readSafeDirs()).toContain("*");

      process.env.SHIPIT_GIT_STRICT_OWNERSHIP = "1";
      initGlobalGitConfig(tmpDir);
      expect(readSafeDirs()).toEqual([]);
    });

    it("restores the entry when the switch is turned back off", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      process.env.SHIPIT_GIT_STRICT_OWNERSHIP = "1";
      initGlobalGitConfig(tmpDir);
      delete process.env.SHIPIT_GIT_STRICT_OWNERSHIP;
      initGlobalGitConfig(tmpDir);
      expect(readSafeDirs()).toContain("*");
    });

    it("is off unless the value is exactly 1", () => {
      for (const value of ["", "0", "true", "yes"]) {
        expect(gitStrictOwnership({ SHIPIT_GIT_STRICT_OWNERSHIP: value })).toBe(false);
      }
      expect(gitStrictOwnership({})).toBe(false);
      expect(gitStrictOwnership({ SHIPIT_GIT_STRICT_OWNERSHIP: "1" })).toBe(true);
    });
  });
});

// docs/200 — the orchestrator container has no SSH key / known_hosts, so a git op
// over an SSH github.com remote dies with "Host key verification failed" before
// auth. initGlobalGitConfig installs a global url.insteadOf so every orchestrator
// git op transparently uses HTTPS (and thus the credential-helper token) even
// when the remote is written as SSH. This is what keeps the self-update fetch
// working after /opt/shipit's origin is re-pointed at an SSH URL.
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
      return []; // key absent → git exits non-zero
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
    // Prove git actually applies the rewrite: with the global insteadOf in place,
    // git resolves an SCP-style remote to its HTTPS form. `ls-remote --get-url`
    // reports the URL git WOULD use for transport (post-insteadOf) without any
    // network access.
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
