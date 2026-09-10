import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitHubAuthManager, validateGitHubToken, checkGitHubToken } from "./github-auth.js";
import { CredentialStore } from "./credential-store.js";
import {
  getGitIdentity,
  initGlobalGitConfig,
  clearGlobalCredentialHelper,
  CONTAINER_CREDENTIAL_HELPER,
} from "./git-config.js";

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

    it("preserves the token when GitHub is unreachable (5xx outage), no event", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

      credentialStore.setGithubToken("ghp_validtoken");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();

      const events: unknown[] = [];
      mgr.on("token_invalid", (ev) => events.push(ev));

      const did = await mgr.markTokenInvalid("auto-push failed during GitHub outage");
      expect(did).toBe(false);
      expect(mgr.authenticated).toBe(true);
      expect(credentialStore.getGithubToken()).toBe("ghp_validtoken");
      expect(events).toEqual([]);
    });

    it("preserves the token when the verification request itself errors (network failure)", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

      credentialStore.setGithubToken("ghp_validtoken");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();

      const events: unknown[] = [];
      mgr.on("token_invalid", (ev) => events.push(ev));

      const did = await mgr.markTokenInvalid("auto-push failed: network down");
      expect(did).toBe(false);
      expect(mgr.authenticated).toBe(true);
      expect(credentialStore.getGithubToken()).toBe("ghp_validtoken");
      expect(events).toEqual([]);
    });

    it("preserves the token on a rate-limit 403 (not a credential rejection)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      );

      credentialStore.setGithubToken("ghp_validtoken");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();

      const did = await mgr.markTokenInvalid("auto-push failed while rate-limited");
      expect(did).toBe(false);
      expect(mgr.authenticated).toBe(true);
      expect(credentialStore.getGithubToken()).toBe("ghp_validtoken");
    });
  });

  describe("loadUserInfo token preservation", () => {
    it("clears the token only on an explicit 401", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));
      credentialStore.setGithubToken("ghp_revoked");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();

      await mgr.loadUserInfo();

      expect(mgr.authenticated).toBe(false);
      expect(credentialStore.getGithubToken()).toBeNull();
    });

    it("keeps the token when GitHub is unreachable on boot (5xx)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Service Unavailable", { status: 503 }));
      credentialStore.setGithubToken("ghp_during_outage");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();

      await mgr.loadUserInfo();

      expect(mgr.authenticated).toBe(true);
      expect(credentialStore.getGithubToken()).toBe("ghp_during_outage");
    });

    it("keeps the token when the boot verification request errors (network failure)", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.github.com"));
      credentialStore.setGithubToken("ghp_during_outage");
      const mgr = new GitHubAuthManager(tmpDir, credentialStore);
      mgr.checkCredentials();

      await mgr.loadUserInfo();

      expect(mgr.authenticated).toBe(true);
      expect(credentialStore.getGithubToken()).toBe("ghp_during_outage");
    });
  });
});

describe("GitHubAuthManager.configureGitCredentials (docs/172 Gap 2 / planning#74)", () => {
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
    initGlobalGitConfig(tmpDir);

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

  function credentialFill(host: string): string {
    try {
      return execFileSync("git", ["credential", "fill"], {
        cwd: workspaceDir,
        input: `protocol=https\nhost=${host}\n\n`,
        encoding: "utf-8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
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
    clearGlobalCredentialHelper();
    mgr.configureGitCredentials(workspaceDir);

    const out = credentialFill("attacker.example.com");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("password=ghp_");
  });

  it("git credential fill for github.com still resolves the token via the global helper (push/pull unaffected)", () => {
    credentialStore.setGithubToken(TOKEN);
    const mgr = new GitHubAuthManager(workspaceDir, credentialStore);
    mgr.checkCredentials();
    mgr.configureGitCredentials(workspaceDir);

    const out = credentialFill("github.com");
    expect(out).toContain("username=x-access-token");
    expect(out).toContain(`password=${TOKEN}`);
  });

  it("silently skips a target dir that no longer exists (no spurious ENOENT)", () => {
    credentialStore.setGithubToken(TOKEN);
    const mgr = new GitHubAuthManager(workspaceDir, credentialStore);
    mgr.checkCredentials();

    const gone = path.join(tmpDir, "reclaimed-session", "workspace");
    expect(fs.existsSync(gone)).toBe(false);
    expect(() => mgr.configureGitCredentials(gone)).not.toThrow();
  });
});

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input !== "string") throw new Error("Expected string URL in test");
  return input;
}

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

  function mockGraphqlError(message: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = urlOf(input);
      if (u.endsWith("/pulls/42") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ node_id: "PR_node_42", title: "t", body: null }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (u === "https://api.github.com/graphql") {
        return new Response(JSON.stringify({ errors: [{ message }] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });
  }

  it("maps a GitHub auto-merge-disabled error to actionable repo-settings guidance", async () => {
    const fetchSpy = mockGraphqlError("Auto merge is not allowed for this repository");
    const mgr = new GitHubAuthManager(tmpDir, credentialStore);
    mgr.checkCredentials();
    const result = await mgr.enableAutoMerge("o", "r", 42, "SQUASH");

    expect(result.success).toBe(false);
    expect(result.message).toContain("Allow auto-merge");
    expect(result.message).toContain("Settings");
    fetchSpy.mockRestore();
  });

  it("maps a 'clean status' error to required-check guidance", async () => {
    const fetchSpy = mockGraphqlError("Pull request is in clean status");
    const mgr = new GitHubAuthManager(tmpDir, credentialStore);
    mgr.checkCredentials();
    const result = await mgr.enableAutoMerge("o", "r", 42, "SQUASH");

    expect(result.success).toBe(false);
    expect(result.message).toContain("required check");
    fetchSpy.mockRestore();
  });

  it("passes through an unrecognized GraphQL error verbatim", async () => {
    const fetchSpy = mockGraphqlError("Some novel GitHub error");
    const mgr = new GitHubAuthManager(tmpDir, credentialStore);
    mgr.checkCredentials();
    const result = await mgr.enableAutoMerge("o", "r", 42, "SQUASH");

    expect(result.success).toBe(false);
    expect(result.message).toBe("Some novel GitHub error");
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

describe("checkGitHubToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies a 200 with profile as valid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ login: "octocat", avatar_url: "https://example.com/a.png", id: 7, name: "Octo" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await checkGitHubToken("ghp_valid");
    expect(result).toEqual({
      status: "valid",
      user: { username: "octocat", avatarUrl: "https://example.com/a.png", id: 7, displayName: "Octo" },
    });
  });

  it("classifies a 401 as invalid (the only token-rejection signal)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const result = await checkGitHubToken("ghp_bad");
    expect(result.status).toBe("invalid");
  });

  it("classifies a 5xx outage as indeterminate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    const result = await checkGitHubToken("ghp_unknown");
    expect(result.status).toBe("indeterminate");
  });

  it("classifies a 403 rate-limit as indeterminate (not a rejection)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 403 }));
    const result = await checkGitHubToken("ghp_unknown");
    expect(result.status).toBe("indeterminate");
  });

  it("classifies a thrown fetch (network error) as indeterminate", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const result = await checkGitHubToken("ghp_unknown");
    expect(result.status).toBe("indeterminate");
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
          "x-ratelimit-reset": "1747843200",
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
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": "60" } }),
    );
    await mgr.graphqlQuery("query{ x }");
    expect(mgr.getRateLimitState().limited).toBe(true);

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

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "4999" },
      }),
    );
    await mgr.graphqlQuery("q");
    expect(events).toHaveLength(0);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 403, headers: { "retry-after": "60" } }),
    );
    await mgr.graphqlQuery("q");
    expect(events).toHaveLength(1);

    expect(mgr.getRateLimitState().limited).toBe(true);
  });
});

describe("GitHubAuthManager.createRepo — owner routing", () => {
  let tmpDir: string;
  let mgr: GitHubAuthManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-create-repo-"));
    const store = new CredentialStore(tmpDir);
    store.setGithubToken("ghp_x");
    mgr = new GitHubAuthManager(tmpDir, store);
    mgr.checkCredentials();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function repoResponse(): Response {
    return new Response(
      JSON.stringify({
        name: "r",
        full_name: "o/r",
        html_url: "https://github.com/o/r",
        clone_url: "https://github.com/o/r.git",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  }

  it("POSTs to /user/repos when no owner is given (personal account)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(repoResponse());

    const res = await mgr.createRepo("my-repo", { isPrivate: true });

    expect(res.success).toBe(true);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.github.com/user/repos");
  });

  it("POSTs to /orgs/{owner}/repos when an owner is given", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(repoResponse());

    await mgr.createRepo("my-repo", { owner: "acme" });

    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.github.com/orgs/acme/repos");
  });
});

describe("GitHubAuthManager.listOrgs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-list-orgs-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function authedManager(): GitHubAuthManager {
    const store = new CredentialStore(tmpDir);
    store.setGithubToken("ghp_x");
    const mgr = new GitHubAuthManager(tmpDir, store);
    mgr.checkCredentials();
    return mgr;
  }

  it("returns [] when unauthenticated", async () => {
    const mgr = new GitHubAuthManager(tmpDir, new CredentialStore(tmpDir));
    expect(await mgr.listOrgs()).toEqual([]);
  });

  it("maps GitHub org logins and avatar URLs", async () => {
    const mgr = authedManager();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { login: "acme", avatar_url: "https://a/acme.png" },
          { login: "globex", avatar_url: "https://a/globex.png" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    expect(await mgr.listOrgs()).toEqual([
      { login: "acme", avatarUrl: "https://a/acme.png" },
      { login: "globex", avatarUrl: "https://a/globex.png" },
    ]);
  });

  it("returns [] on a non-OK response instead of throwing", async () => {
    const mgr = authedManager();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }));
    expect(await mgr.listOrgs()).toEqual([]);
  });
});
