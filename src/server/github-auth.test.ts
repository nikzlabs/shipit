import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitHubAuthManager, validateGitHubToken } from "./github-auth.js";

describe("GitHubAuthManager", () => {
  let tmpDir: string;
  let tokenPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-github-auth-"));
    tokenPath = path.join(tmpDir, ".github-token");

    // Initialize a git repo so configureGitCredentials works
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("checkCredentials", () => {
    it("returns false when no token file exists", () => {
      const mgr = new GitHubAuthManager(tmpDir, tokenPath);
      expect(mgr.checkCredentials()).toBe(false);
      expect(mgr.authenticated).toBe(false);
    });

    it("returns true and loads token when file exists", () => {
      fs.writeFileSync(tokenPath, "ghp_testtoken123");
      const mgr = new GitHubAuthManager(tmpDir, tokenPath);
      expect(mgr.checkCredentials()).toBe(true);
      expect(mgr.authenticated).toBe(true);
    });

    it("returns false when token file is empty", () => {
      fs.writeFileSync(tokenPath, "");
      const mgr = new GitHubAuthManager(tmpDir, tokenPath);
      expect(mgr.checkCredentials()).toBe(false);
      expect(mgr.authenticated).toBe(false);
    });

    it("returns false when token file is whitespace only", () => {
      fs.writeFileSync(tokenPath, "   \n  ");
      const mgr = new GitHubAuthManager(tmpDir, tokenPath);
      expect(mgr.checkCredentials()).toBe(false);
    });
  });

  describe("setToken", () => {
    it("rejects empty token", async () => {
      const mgr = new GitHubAuthManager(tmpDir, tokenPath);
      const failedHandler = vi.fn();
      mgr.on("auth_failed", failedHandler);

      const result = await mgr.setToken("");
      expect(result).toBe(false);
      expect(failedHandler).toHaveBeenCalledWith("Token cannot be empty");
    });

    it("rejects whitespace-only token", async () => {
      const mgr = new GitHubAuthManager(tmpDir, tokenPath);
      const failedHandler = vi.fn();
      mgr.on("auth_failed", failedHandler);

      const result = await mgr.setToken("   ");
      expect(result).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("returns unauthenticated status by default", () => {
      const mgr = new GitHubAuthManager(tmpDir, tokenPath);
      const status = mgr.getStatus();
      expect(status.authenticated).toBe(false);
      expect(status.username).toBeUndefined();
      expect(status.avatarUrl).toBeUndefined();
    });
  });

  describe("clearCredentials", () => {
    it("removes token file and resets state", () => {
      fs.writeFileSync(tokenPath, "ghp_testtoken");
      const mgr = new GitHubAuthManager(tmpDir, tokenPath);
      mgr.checkCredentials();
      expect(mgr.authenticated).toBe(true);

      mgr.clearCredentials();
      expect(mgr.authenticated).toBe(false);
      expect(fs.existsSync(tokenPath)).toBe(false);
      expect(mgr.getStatus().username).toBeUndefined();
    });

    it("is safe to call when no token exists", () => {
      const mgr = new GitHubAuthManager(tmpDir, tokenPath);
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
