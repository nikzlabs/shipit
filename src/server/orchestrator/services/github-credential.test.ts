import { describe, it, expect } from "vitest";
import { getGitCredential } from "./github.js";
import type { GitHubAuthManager } from "../github-auth.js";

/** Minimal stub exposing just the `getToken()` the service reads. */
function stubAuth(token: string | null): GitHubAuthManager {
  return { getToken: () => token } as unknown as GitHubAuthManager;
}

describe("getGitCredential (docs/088 finding #5)", () => {
  it("returns the token as password for github.com", () => {
    const cred = getGitCredential(stubAuth("ghp_secret"), "github.com");
    expect(cred).toEqual({ username: "x-access-token", password: "ghp_secret" });
  });

  it("is case-insensitive and trims the host", () => {
    expect(getGitCredential(stubAuth("ghp_secret"), "  GitHub.com ")).toEqual({
      username: "x-access-token",
      password: "ghp_secret",
    });
  });

  it("returns null for non-github hosts (never hands the PAT to other remotes)", () => {
    expect(getGitCredential(stubAuth("ghp_secret"), "gitlab.com")).toBeNull();
    expect(getGitCredential(stubAuth("ghp_secret"), "evil.example.com")).toBeNull();
  });

  it("returns null when no host is supplied", () => {
    expect(getGitCredential(stubAuth("ghp_secret"), undefined)).toBeNull();
    expect(getGitCredential(stubAuth("ghp_secret"), "")).toBeNull();
  });

  it("returns null when no token is configured", () => {
    expect(getGitCredential(stubAuth(null), "github.com")).toBeNull();
  });
});
