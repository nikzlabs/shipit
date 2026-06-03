import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitHubAuthManager, validateGitHubToken } from "./github-auth.js";
import { CredentialStore } from "./credential-store.js";
import {
  getGitIdentity,
  initGlobalGitConfig,
  clearGlobalCredentialHelper,
  CONTAINER_CREDENTIAL_HELPER,
} from "./git-config.js";

/** Create a mock GitHub API response for fetch. */
function mockGitHubUserResponse(data: { login: string; avatar_url: string; id: number; name: string | null }): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

describe("GitHubAuthManager", () => {
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let origGitConfigGlobal: string | undefined;
  let origGithubToken: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-github-auth-"));
    credentialStore = new CredentialStore(tmpDir);
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    // Clear GITHUB_TOKEN so checkCredentials() tests don't accidentally
    // pick up an env-injected token from the CI shell. Individual tests
    // that exercise the env-fallback path re-set it explicitly.
    origGithubToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    initGlobalGitConfig(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origGitConfigGlobal !== undefined) {
      process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    } else {
      delete process.env.GIT_CONFIG_GLOBAL;
    }
    if (origGithubToken !== undefined) {
      process.env.GITHUB_TOKEN = origGithubToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("checkCredentials", () => {
    it("returns false when no token stored", () => {
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      expect(mgr.checkCredentials()).toBe(false);
      expect(mgr.authenticated).toBe(false);
    });

    it("returns true and loads token when stored", () => {
      credentialStore.setGithubToken("ghp_testtoken123");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      expect(mgr.checkCredentials()).toBe(true);
      expect(mgr.authenticated).toBe(true);
    });

    it("falls back to GITHUB_TOKEN env var when disk has nothing (dogfooding)", () => {
      process.env.GITHUB_TOKEN = "ghp_from_env_456";
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      expect(mgr.checkCredentials()).toBe(true);
      expect(mgr.authenticated).toBe(true);
      expect(mgr.getToken()).toBe("ghp_from_env_456");
    });

    it("ignores empty / whitespace GITHUB_TOKEN env var", () => {
      process.env.GITHUB_TOKEN = "   ";
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      expect(mgr.checkCredentials()).toBe(false);
      expect(mgr.authenticated).toBe(false);
    });

    it("prefers disk token over env var when both are present", () => {
      credentialStore.setGithubToken("ghp_disk_token");
      process.env.GITHUB_TOKEN = "ghp_env_token";
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      expect(mgr.checkCredentials()).toBe(true);
      expect(mgr.getToken()).toBe("ghp_disk_token");
    });

    it("does not persist env-sourced token to disk", () => {
      process.env.GITHUB_TOKEN = "ghp_from_env_only";
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      expect(mgr.checkCredentials()).toBe(true);
      // The CredentialStore on disk should remain empty — env is the source
      // of truth in dogfooding mode and we don't want to mask token rotation
      // with a stale on-disk copy.
      expect(credentialStore.getGithubToken()).toBeNull();
    });
  });

  describe("setToken", () => {
    it("rejects empty token", async () => {
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      const failedHandler = vi.fn();
      mgr.on("auth_failed", failedHandler);

      const result = await mgr.setToken("");
      expect(result).toBe(false);
      expect(failedHandler).toHaveBeenCalledWith("Token cannot be empty");
    });

    it("rejects whitespace-only token", async () => {
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      const failedHandler = vi.fn();
      mgr.on("auth_failed", failedHandler);

      const result = await mgr.setToken("   ");
      expect(result).toBe(false);
    });

    it("sets global git identity with display name on success", async () => {
      mockGitHubUserResponse({ login: "octocat", avatar_url: "https://example.com/avatar.png", id: 12345, name: "The Octocat" });
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);

      const result = await mgr.setToken("ghp_valid_token");
      expect(result).toBe(true);

      const identity = getGitIdentity();
      expect(identity).toEqual({ name: "The Octocat", email: "12345+octocat@users.noreply.github.com" });
    });

    it("falls back to login when display name is null", async () => {
      mockGitHubUserResponse({ login: "octocat", avatar_url: "https://example.com/avatar.png", id: 12345, name: null });
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);

      const result = await mgr.setToken("ghp_valid_token");
      expect(result).toBe(true);

      const identity = getGitIdentity();
      expect(identity).toEqual({ name: "octocat", email: "12345+octocat@users.noreply.github.com" });
    });

    it("does not set git identity on validation failure", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);

      const result = await mgr.setToken("ghp_bad_token");
      expect(result).toBe(false);
      expect(getGitIdentity()).toBeNull();
    });
  });

  describe("getStatus", () => {
    it("returns unauthenticated status by default", () => {
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      const status = mgr.getStatus();
      expect(status.authenticated).toBe(false);
      expect(status.username).toBeUndefined();
      expect(status.avatarUrl).toBeUndefined();
    });
  });

  describe("loadUserInfo", () => {
    it("sets global git identity from stored token", async () => {
      mockGitHubUserResponse({ login: "octocat", avatar_url: "https://example.com/avatar.png", id: 12345, name: "The Octocat" });
      credentialStore.setGithubToken("ghp_stored_token");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();

      await mgr.loadUserInfo();

      const identity = getGitIdentity();
      expect(identity).toEqual({ name: "The Octocat", email: "12345+octocat@users.noreply.github.com" });
    });
  });

  describe("clearCredentials", () => {
    it("removes token and resets state", () => {
      credentialStore.setGithubToken("ghp_testtoken");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();
      expect(mgr.authenticated).toBe(true);

      mgr.clearCredentials();
      expect(mgr.authenticated).toBe(false);
      expect(credentialStore.getGithubToken()).toBeNull();
      expect(mgr.getStatus().username).toBeUndefined();
    });

    it("is safe to call when no token exists", () => {
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      expect(() => mgr.clearCredentials()).not.toThrow();
    });
  });

  describe("markTokenInvalid", () => {
    it("clears credentials and emits token_invalid when GitHub also rejects the token", async () => {
      // GET /user fails too → the token really is invalid → clear it.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));

      credentialStore.setGithubToken("ghp_testtoken");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();
      expect(mgr.authenticated).toBe(true);

      const events: { reason: string }[] = [];
      mgr.on("token_invalid", (ev) => events.push(ev as { reason: string }));

      const did = await mgr.markTokenInvalid("auto-push failed: Authentication failed");
      expect(did).toBe(true);
      expect(mgr.authenticated).toBe(false);
      expect(credentialStore.getGithubToken()).toBeNull();
      expect(events).toEqual([{ reason: "auto-push failed: Authentication failed" }]);
    });

    it("preserves a token that still validates against GET /user (repo-specific 401 from a fine-grained PAT)", async () => {
      // GET /user succeeds → the token is still valid globally; the per-repo
      // git failure was a scope issue, not an expired credential. The token
      // must not be cleared and no `token_invalid` event must be emitted.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ login: "octocat", avatar_url: "https://example.com/a.png", id: 1, name: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      credentialStore.setGithubToken("ghp_validtoken");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();
      expect(mgr.authenticated).toBe(true);

      const events: unknown[] = [];
      mgr.on("token_invalid", (ev) => events.push(ev));

      const did = await mgr.markTokenInvalid("claim-session refresh failed: Invalid username or token");
      expect(did).toBe(false);
      expect(mgr.authenticated).toBe(true);
      expect(credentialStore.getGithubToken()).toBe("ghp_validtoken");
      expect(events).toEqual([]);
    });

    it("is a no-op when no token is configured (no event, returns false)", async () => {
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      const events: unknown[] = [];
      mgr.on("token_invalid", (ev) => events.push(ev));

      const did = await mgr.markTokenInvalid("nothing to invalidate");
      expect(did).toBe(false);
      expect(events).toEqual([]);
    });
  });
});

describe("GitHubAuthManager.configureGitCredentials (docs/172 Gap 2 / SHI-72)", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let credentialStore: CredentialStore;
  let origGitConfigGlobal: string | undefined;
  let origGithubToken: string | undefined;

  const TOKEN = "ghp_super_secret_workspace_token";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-cfg-git-creds-"));
    credentialStore = new CredentialStore(tmpDir);
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGithubToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    // Point the global git config at a fresh, token-free file in tmpDir.
    initGlobalGitConfig(tmpDir);

    // A real git repo whose LOCAL .git/config we configure.
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspaceDir });
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGithubToken !== undefined) process.env.GITHUB_TOKEN = origGithubToken;
    else delete process.env.GITHUB_TOKEN;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Run `git credential fill` in the workspace; return combined stdout+stderr. */
  function credentialFill(host: string): string {
    try {
      return execFileSync("git", ["credential", "fill"], {
        cwd: workspaceDir,
        input: `protocol=https\nhost=${host}\n\n`,
        encoding: "utf-8",
        // Disable interactive prompts and the system gitconfig so the test
        // observes only the global + local helpers we control.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // With no helper able to supply a password and prompts disabled, git
      // exits non-zero — capture whatever it emitted so the test can assert
      // the token never appears in any output channel.
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      return `${String(e.stdout ?? "")}${String(e.stderr ?? "")}`;
    }
  }

  it("never writes the PAT in plaintext into the workspace .git/config", () => {
    credentialStore.setGithubToken(TOKEN);
    const mgr = new GitHubAuthManager(workspaceDir, credentialStore);
    mgr.checkCredentials();

    mgr.configureGitCredentials(workspaceDir);

    const config = fs.readFileSync(path.join(workspaceDir, ".git", "config"), "utf-8");
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain("ghp_");
    // The workspace is routed through the brokering helper instead of an
    // inline token echo.
    const helper = execFileSync("git", ["config", "--local", "credential.helper"], {
      cwd: workspaceDir,
      encoding: "utf-8",
    }).trim();
    expect(helper).toBe(CONTAINER_CREDENTIAL_HELPER);
  });

  it("git credential fill for a non-GitHub host returns no credentials (no token leak)", () => {
    credentialStore.setGithubToken(TOKEN);
    const mgr = new GitHubAuthManager(workspaceDir, credentialStore);
    mgr.checkCredentials();
    // `checkCredentials` installs the orchestrator's global inline helper.
    // Clear it so this test isolates the *workspace* config: pre-fix, the
    // inline local helper echoed the token for ANY host straight from
    // .git/config. With the brokering helper (whose binary is absent on the
    // orchestrator/test host, and which is host-scoped anyway), no token is
    // ever produced for an attacker host.
    clearGlobalCredentialHelper();
    mgr.configureGitCredentials(workspaceDir);

    const out = credentialFill("attacker.example.com");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("password=ghp_");
  });

  it("git credential fill for github.com still resolves the token via the global helper (push/pull unaffected)", () => {
    credentialStore.setGithubToken(TOKEN);
    const mgr = new GitHubAuthManager(workspaceDir, credentialStore);
    mgr.checkCredentials(); // installs the global inline helper (orchestrator side)
    mgr.configureGitCredentials(workspaceDir); // local broker helper

    // The global inline helper is consulted first and fills the credential, so
    // the (orchestrator-side) push/pull path is unaffected even though the
    // local config now points at the broker.
    const out = credentialFill("github.com");
    expect(out).toContain("username=x-access-token");
    expect(out).toContain(`password=${TOKEN}`);
  });
});

/** Narrow fetch's `url` argument to a string. The auth manager only ever
 * passes string URLs, so we assert that and keep the test types clean. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input !== "string") throw new Error("Expected string URL in test");
  return input;
}

/** Narrow fetch's `init.body` to a string. The auth manager only sends JSON
 * strings, so this is a safe narrowing for tests. */
function jsonBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected JSON string body in test");
  return JSON.parse(body);
}

describe("GitHubAuthManager.mergePullRequest", () => {
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-merge-pr-"));
    credentialStore = new CredentialStore(tmpDir);
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    credentialStore.setGithubToken("ghp_token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origGitConfigGlobal !== undefined) {
      process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    } else {
      delete process.env.GIT_CONFIG_GLOBAL;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards the PR title and body as commit_title / commit_message", async () => {
    // First fetch (viewPullRequest in the wrapper) returns PR details. Second
    // fetch (mergePullRequest impl) is the actual PUT we want to inspect.
    let mergeBody: Record<string, unknown> | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = urlOf(input);
      if (u.endsWith("/pulls/42") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({
          html_url: "https://github.com/o/r/pull/42",
          number: 42,
          base: { ref: "main" },
          head: { ref: "feature" },
          title: "Add fancy feature",
          body: "Closes #1\n\nDetails about the feature.",
          state: "open",
          draft: false,
          merged: false,
          additions: 10,
          deletions: 5,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.endsWith("/pulls/42/merge")) {
        mergeBody = jsonBody(init) as Record<string, unknown>;
        return new Response(JSON.stringify({ merged: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${u}`);
    });

    const mgr = new GitHubAuthManager(tmpDir, credentialStore);
    mgr.checkCredentials();
    const result = await mgr.mergePullRequest("o", "r", 42, "squash");

    expect(result.success).toBe(true);
    expect(mergeBody).toEqual({
      merge_method: "squash",
      commit_title: "Add fancy feature",
      commit_message: "Closes #1\n\nDetails about the feature.",
    });
    fetchSpy.mockRestore();
  });

  it("falls back to omitting commit_title when PR detail fetch fails", async () => {
    let mergeBody: Record<string, unknown> | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = urlOf(input);
      if (u.endsWith("/pulls/42") && (init?.method ?? "GET") === "GET") {
        return new Response("Not Found", { status: 404 });
      }
      if (u.endsWith("/pulls/42/merge")) {
        mergeBody = jsonBody(init) as Record<string, unknown>;
        return new Response(JSON.stringify({ merged: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${u}`);
    });

    const mgr = new GitHubAuthManager(tmpDir, credentialStore);
    mgr.checkCredentials();
    const result = await mgr.mergePullRequest("o", "r", 42, "squash");

    expect(result.success).toBe(true);
    expect(mergeBody).toEqual({ merge_method: "squash" });
    fetchSpy.mockRestore();
  });
});

describe("GitHubAuthManager.enableAutoMerge", () => {
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-auto-merge-"));
    credentialStore = new CredentialStore(tmpDir);
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    credentialStore.setGithubToken("ghp_token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origGitConfigGlobal !== undefined) {
      process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    } else {
      delete process.env.GIT_CONFIG_GLOBAL;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards PR title and body as commitHeadline / commitBody to GraphQL", async () => {
    let graphqlVariables: Record<string, unknown> | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = urlOf(input);
      if (u.endsWith("/pulls/42") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({
          node_id: "PR_node_42",
          title: "Add fancy feature",
          body: "Closes #1",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u === "https://api.github.com/graphql") {
        const payload = jsonBody(init) as { variables: Record<string, unknown> };
        graphqlVariables = payload.variables;
        return new Response(JSON.stringify({ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "now" } } } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });

    const mgr = new GitHubAuthManager(tmpDir, credentialStore);
    mgr.checkCredentials();
    const result = await mgr.enableAutoMerge("o", "r", 42, "SQUASH");

    expect(result.success).toBe(true);
    expect(graphqlVariables).toEqual({
      prId: "PR_node_42",
      method: "SQUASH",
      commitHeadline: "Add fancy feature",
      commitBody: "Closes #1",
    });
    fetchSpy.mockRestore();
  });

  it("uses empty string for commitBody when PR body is null", async () => {
    let graphqlVariables: Record<string, unknown> | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = urlOf(input);
      if (u.endsWith("/pulls/42") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({
          node_id: "PR_node_42",
          title: "Add fancy feature",
          body: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u === "https://api.github.com/graphql") {
        const payload = jsonBody(init) as { variables: Record<string, unknown> };
        graphqlVariables = payload.variables;
        return new Response(JSON.stringify({ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "now" } } } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });

    const mgr = new GitHubAuthManager(tmpDir, credentialStore);
    mgr.checkCredentials();
    await mgr.enableAutoMerge("o", "r", 42, "SQUASH");

    expect(graphqlVariables).toMatchObject({ commitBody: "" });
    fetchSpy.mockRestore();
  });
});

describe("validateGitHubToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for invalid token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const result = await validateGitHubToken("invalid_token_xxx");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));
    const result = await validateGitHubToken("invalid_token_xxx");
    expect(result).toBeNull();
  });

  it("returns user info for valid token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ login: "octocat", avatar_url: "https://example.com/avatar.png", id: 12345, name: "The Octocat" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await validateGitHubToken("ghp_valid_token");
    expect(result).toEqual({ username: "octocat", avatarUrl: "https://example.com/avatar.png", id: 12345, displayName: "The Octocat" });
  });
});

describe("GitHubAuthManager.graphqlQuery rate-limit handling", () => {
  let tmpDir: string;
  let mgr: GitHubAuthManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-graphql-rl-"));
    const store = new CredentialStore(tmpDir);
    store.setGithubToken("ghp_test");
    mgr = new GitHubAuthManager(tmpDir, store);
    mgr.checkCredentials();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null and flips rate-limit state on HTTP 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1747843200", // epoch seconds
        },
      }),
    );
    const result = await mgr.graphqlQuery("query{ viewer{ login } }");
    expect(result).toBeNull();
    const state = mgr.getRateLimitState();
    expect(state.limited).toBe(true);
    expect(state.resetAt).toBe(1747843200 * 1000);
    expect(state.remaining).toBe(0);
  });

  it("treats 200 + errors[].type RATE_LIMITED as a failure and returns null", async () => {
    // GitHub's nastiest rate-limit shape: 200 OK with empty-looking data and
    // the rate-limit signal hiding in `errors[]`. Without the body-level
    // check, the poller would interpret this as "no PRs" and promote every
    // tracked session to merged.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: { repository: { pullRequests: { nodes: [] } } },
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      }), { status: 200, headers: { "x-ratelimit-remaining": "0" } }),
    );
    const result = await mgr.graphqlQuery("query{ x }");
    expect(result).toBeNull();
    expect(mgr.getRateLimitState().limited).toBe(true);
  });

  it("treats 200 + errors[].type RATE_LIMIT (graphql_rate_limit) as a failure", async () => {
    // The shape prod actually sees when the primary GraphQL budget is exhausted:
    // GitHub returns `type:"RATE_LIMIT"` (singular) with `code:"graphql_rate_limit"`,
    // not the `RATE_LIMITED` label the docs hint at. Previously this slipped
    // through the predicate and the poller hammered GitHub at full cadence.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: null,
        errors: [{ type: "RATE_LIMIT", code: "graphql_rate_limit", message: "API rate limit already exceeded for user ID 1146358." }],
      }), { status: 200, headers: { "x-ratelimit-remaining": "0" } }),
    );
    const result = await mgr.graphqlQuery("query{ x }");
    expect(result).toBeNull();
    expect(mgr.getRateLimitState().limited).toBe(true);
  });

  it("falls back to errors[].code graphql_rate_limit when type is unfamiliar", async () => {
    // Defense in depth: if GitHub renames the type yet again, the `code` field
    // should still trip the predicate.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: null,
        errors: [{ type: "SOME_NEW_TYPE", code: "graphql_rate_limit", message: "rate limited" }],
      }), { status: 200 }),
    );
    const result = await mgr.graphqlQuery("query{ x }");
    expect(result).toBeNull();
    expect(mgr.getRateLimitState().limited).toBe(true);
  });

  it("treats 200 + errors[].type SECONDARY_RATE_LIMITED similarly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: null,
        errors: [{ type: "SECONDARY_RATE_LIMITED", message: "abuse limit" }],
      }), { status: 200 }),
    );
    const result = await mgr.graphqlQuery("query{ x }");
    expect(result).toBeNull();
    expect(mgr.getRateLimitState().limited).toBe(true);
  });

  it("clears rate-limit state on a clean 200 response", async () => {
    // First call: limited.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": "60" } }),
    );
    await mgr.graphqlQuery("query{ x }");
    expect(mgr.getRateLimitState().limited).toBe(true);

    // Second call: success.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { viewer: { login: "octocat" } } }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "4998" },
      }),
    );
    const result = await mgr.graphqlQuery("query{ viewer{ login } }");
    expect(result).not.toBeNull();
    const state = mgr.getRateLimitState();
    expect(state.limited).toBe(false);
    expect(state.remaining).toBe(4998);
  });

  it("honors retry-after header for resetAt when present", async () => {
    const before = Date.now();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 403, headers: { "retry-after": "30" } }),
    );
    await mgr.graphqlQuery("query{ x }");
    const state = mgr.getRateLimitState();
    expect(state.limited).toBe(true);
    expect(state.resetAt).not.toBeNull();
    expect(state.resetAt!).toBeGreaterThanOrEqual(before + 29_000);
    expect(state.resetAt!).toBeLessThanOrEqual(before + 31_000);
  });

  it("emits rate_limit_changed only on transitions", async () => {
    const events: unknown[] = [];
    mgr.on("rate_limit_changed", (e) => events.push(e));

    // Clean success — was already clean, no event.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "4999" },
      }),
    );
    await mgr.graphqlQuery("q");
    expect(events).toHaveLength(0);

    // Now hit a 403 — transition, should fire.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 403, headers: { "retry-after": "60" } }),
    );
    await mgr.graphqlQuery("q");
    expect(events).toHaveLength(1);

    // Another 403 with same shape — limited stays true, resetAt may shift
    // slightly because retry-after is relative; the implementation only
    // emits if `limited` or `resetAt` changed, so this can be 1 or 2 events
    // depending on timing. Just confirm it didn't silently lose state.
    expect(mgr.getRateLimitState().limited).toBe(true);
  });
});
