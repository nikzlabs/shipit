import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createPlatformCredentialProvider,
  fixedPlatformCredentialProvider,
  isPlatformSource,
  PLATFORM_SOURCES,
} from "./platform-credentials.js";

// Minimal stub doubles — the provider only reads `.authenticated` and
// `getToken()` on GitHubAuthManager and `process.env.ANTHROPIC_API_KEY`
// for Claude. AuthManager is referenced for symmetry but isn't read by
// the default implementation (the OAuth token is read directly from the
// CLI's credentials file).
function makeStubGithub(token: string | null) {
  return {
    authenticated: token !== null,
    checkCredentials: () => token !== null,
    getToken: () => token,
  } as unknown as Parameters<typeof createPlatformCredentialProvider>[0]["githubAuthManager"];
}

function makeStubAuth() {
  return {} as unknown as Parameters<typeof createPlatformCredentialProvider>[0]["authManager"];
}

describe("isPlatformSource", () => {
  it("recognizes known hand-maintained sources", () => {
    expect(isPlatformSource("platform:claude_oauth")).toBe(true);
    expect(isPlatformSource("platform:github_token")).toBe(true);
  });

  it("recognizes MCP OAuth provider sources (docs/088 Phase 2)", () => {
    // Sourced dynamically from MCP_OAUTH_PROVIDERS.
    expect(isPlatformSource("platform:linear_oauth")).toBe(true);
    expect(isPlatformSource("platform:notion_oauth")).toBe(true);
  });

  it("rejects unknown / arbitrary strings", () => {
    expect(isPlatformSource("platform:unknown")).toBe(false);
    expect(isPlatformSource("not-a-source")).toBe(false);
    expect(isPlatformSource("")).toBe(false);
  });
});

describe("createPlatformCredentialProvider — claude_oauth", () => {
  let tmpDir: string;
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-cred-"));
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv !== undefined) process.env.ANTHROPIC_API_KEY = originalEnv;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("prefers ANTHROPIC_API_KEY env var over the OAuth file", () => {
    process.env.ANTHROPIC_API_KEY = "sk-from-env";
    fs.writeFileSync(
      path.join(tmpDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-from-file" } }),
    );
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
      claudeCredentialsDir: tmpDir,
    });
    expect(provider.resolve("platform:claude_oauth")).toBe("sk-from-env");
  });

  it("falls back to the .credentials.json OAuth token", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-oauth-1" } }),
    );
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
      claudeCredentialsDir: tmpDir,
    });
    expect(provider.resolve("platform:claude_oauth")).toBe("sk-oauth-1");
  });

  it("returns null when neither env nor file is present", () => {
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
      claudeCredentialsDir: tmpDir,
    });
    expect(provider.resolve("platform:claude_oauth")).toBeNull();
  });

  it("ignores malformed credentials.json gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, ".credentials.json"), "not valid json {{");
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
      claudeCredentialsDir: tmpDir,
    });
    expect(provider.resolve("platform:claude_oauth")).toBeNull();
  });

  it("ignores credentials.json missing the expected shape", () => {
    fs.writeFileSync(path.join(tmpDir, ".credentials.json"), JSON.stringify({ other: 1 }));
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
      claudeCredentialsDir: tmpDir,
    });
    expect(provider.resolve("platform:claude_oauth")).toBeNull();
  });
});

describe("createPlatformCredentialProvider — github_token", () => {
  it("returns the token when GitHub auth is configured", () => {
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub("ghp_xyz"),
    });
    expect(provider.resolve("platform:github_token")).toBe("ghp_xyz");
  });

  it("returns null when no GitHub token is configured", () => {
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
    });
    expect(provider.resolve("platform:github_token")).toBeNull();
  });
});

describe("createPlatformCredentialProvider — unknown sources", () => {
  it("returns null for unknown source identifiers", () => {
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub("ghp_xyz"),
    });
    expect(provider.resolve("platform:something_else")).toBeNull();
    expect(provider.resolve("not:a:platform:source")).toBeNull();
  });
});

describe("createPlatformCredentialProvider — MCP OAuth providers (docs/088 Phase 2)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plat-cred-mcp-"));
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the access token from CredentialStore when present", async () => {
    const { CredentialStore } = await import("./credential-store.js");
    const store = new CredentialStore(tmpDir);
    store.setMcpOAuthTokens("linear_oauth", {
      accessToken: "lin_at_xyz",
      clientId: "cid",
    });
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
      credentialStore: store,
    });
    expect(provider.resolve("platform:linear_oauth")).toBe("lin_at_xyz");
  });

  it("returns null when the source is in the registry but no token is stored", async () => {
    const { CredentialStore } = await import("./credential-store.js");
    const store = new CredentialStore(tmpDir);
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
      credentialStore: store,
    });
    expect(provider.resolve("platform:linear_oauth")).toBeNull();
  });

  it("returns null when credentialStore wasn't supplied", () => {
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
    });
    expect(provider.resolve("platform:linear_oauth")).toBeNull();
  });

  it("knownSources() includes both hand-maintained sources and MCP OAuth providers", () => {
    const provider = createPlatformCredentialProvider({
      authManager: makeStubAuth(),
      githubAuthManager: makeStubGithub(null),
    });
    const known = provider.knownSources();
    expect(known).toContain("platform:claude_oauth");
    expect(known).toContain("platform:github_token");
    expect(known).toContain("platform:linear_oauth");
    expect(known).toContain("platform:notion_oauth");
  });
});

describe("fixedPlatformCredentialProvider (test helper)", () => {
  it("returns supplied values for known sources", () => {
    const provider = fixedPlatformCredentialProvider({
      "platform:claude_oauth": "sk-test",
      "platform:github_token": "ghp_test",
    });
    expect(provider.resolve("platform:claude_oauth")).toBe("sk-test");
    expect(provider.resolve("platform:github_token")).toBe("ghp_test");
  });

  it("returns null for omitted sources", () => {
    const provider = fixedPlatformCredentialProvider({
      "platform:claude_oauth": "sk-test",
    });
    expect(provider.resolve("platform:github_token")).toBeNull();
  });

  it("returns null for unknown sources", () => {
    const provider = fixedPlatformCredentialProvider({});
    expect(provider.resolve("platform:unknown")).toBeNull();
  });
});

describe("PLATFORM_SOURCES", () => {
  it("includes both expected sources", () => {
    expect(PLATFORM_SOURCES).toContain("platform:claude_oauth");
    expect(PLATFORM_SOURCES).toContain("platform:github_token");
  });
});
