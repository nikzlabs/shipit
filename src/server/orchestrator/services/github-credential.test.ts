import { describe, it, expect } from "vitest";
import { getGitCredential, getRepoScopedGitCredential } from "./github.js";
import type { GitHubAuthManager } from "../github-auth.js";

/** Minimal stub exposing just the `getToken()` the service reads. */
function stubAuth(token: string | null): GitHubAuthManager {
  return { getToken: () => token } as unknown as GitHubAuthManager;
}

/**
 * Stub with App-token support for the repo-scoped broker. `minted` is the
 * installation token returned by `mintRepoScopedToken` (null = mint failed);
 * `appEnabled` toggles whether App tokens are configured at all.
 */
function stubAppAuth(opts: {
  token: string | null;
  appEnabled: boolean;
  minted: string | null;
  onMint?: (owner: string, repo: string) => void;
}): GitHubAuthManager {
  return {
    getToken: () => opts.token,
    appTokensEnabled: () => opts.appEnabled,
    mintRepoScopedToken: async (owner: string, repo: string) => {
      opts.onMint?.(owner, repo);
      return opts.minted;
    },
  } as unknown as GitHubAuthManager;
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

describe("getRepoScopedGitCredential (docs/172 Gap 2-R / SHI-79)", () => {
  it("prefers a minted, repo-scoped installation token when App tokens are enabled", async () => {
    const seen: { owner: string; repo: string }[] = [];
    const auth = stubAppAuth({
      token: "ghp_pat",
      appEnabled: true,
      minted: "ghs_scoped",
      onMint: (owner, repo) => seen.push({ owner, repo }),
    });
    const cred = await getRepoScopedGitCredential(auth, { host: "github.com", owner: "octo", repo: "hello" });
    expect(cred).toEqual({ username: "x-access-token", password: "ghs_scoped" });
    expect(seen).toEqual([{ owner: "octo", repo: "hello" }]);
  });

  it("falls back to the PAT when App tokens are not configured", async () => {
    const auth = stubAppAuth({ token: "ghp_pat", appEnabled: false, minted: null });
    const cred = await getRepoScopedGitCredential(auth, { host: "github.com", owner: "octo", repo: "hello" });
    expect(cred).toEqual({ username: "x-access-token", password: "ghp_pat" });
  });

  it("falls back to the PAT when minting fails (availability over tightness)", async () => {
    const auth = stubAppAuth({ token: "ghp_pat", appEnabled: true, minted: null });
    const cred = await getRepoScopedGitCredential(auth, { host: "github.com", owner: "octo", repo: "hello" });
    expect(cred).toEqual({ username: "x-access-token", password: "ghp_pat" });
  });

  it("falls back to the PAT when the repo can't be identified", async () => {
    const auth = stubAppAuth({ token: "ghp_pat", appEnabled: true, minted: "ghs_scoped" });
    const cred = await getRepoScopedGitCredential(auth, { host: "github.com" });
    expect(cred).toEqual({ username: "x-access-token", password: "ghp_pat" });
  });

  it("enforces host scoping first — never mints or echoes for a non-github host", async () => {
    let minted = false;
    const auth = stubAppAuth({
      token: "ghp_pat",
      appEnabled: true,
      minted: "ghs_scoped",
      onMint: () => { minted = true; },
    });
    expect(await getRepoScopedGitCredential(auth, { host: "evil.example.com", owner: "octo", repo: "hello" })).toBeNull();
    expect(minted).toBe(false);
  });

  it("returns null when no credential of any kind is available", async () => {
    const auth = stubAppAuth({ token: null, appEnabled: false, minted: null });
    expect(await getRepoScopedGitCredential(auth, { host: "github.com", owner: "octo", repo: "hello" })).toBeNull();
  });
});
