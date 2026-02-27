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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-github-auth-"));
    credentialStore = new CredentialStore(tmpDir);
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
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

describe("validateGitHubToken", () => {
  it("returns null for invalid token (network)", async () => {
    // Use a definitely-invalid token — the API will reject it
    const result = await validateGitHubToken("invalid_token_xxx");
    expect(result).toBeNull();
  });
});
