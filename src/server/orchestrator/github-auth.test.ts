import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHubAuthManager, validateGitHubToken } from "./github-auth.js";
import { CredentialStore } from "./credential-store.js";
import { getGitIdentity, initGlobalGitConfig } from "./git-config.js";

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
