import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";

describe("CredentialStore", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function createTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-cred-store-"));
    return tmpDir;
  }

  // ---- Agent env ----

  describe("agentEnv", () => {
    it("returns undefined for unset key", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.getAgentEnv("OPENAI_API_KEY")).toBeUndefined();
    });

    it("set persists and get retrieves", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-test");

      expect(store.getAgentEnv("OPENAI_API_KEY")).toBe("sk-test");
    });

    it("getAllAgentEnv returns all stored keys", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-1");
      store.setAgentEnv("GOOGLE_API_KEY", "AIza-2");

      expect(store.getAllAgentEnv()).toEqual({
        OPENAI_API_KEY: "sk-1",
        GOOGLE_API_KEY: "AIza-2",
      });
    });

    it("new instance reads back saved env", () => {
      const dir = createTmpDir();
      new CredentialStore(dir).setAgentEnv("OPENAI_API_KEY", "sk-persisted");

      const store2 = new CredentialStore(dir);
      expect(store2.getAgentEnv("OPENAI_API_KEY")).toBe("sk-persisted");
    });
  });

  // ---- GitHub token ----

  describe("githubToken", () => {
    it("returns null when not set", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.getGithubToken()).toBeNull();
    });

    it("set and get round-trip", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setGithubToken("ghp_test123");

      expect(store.getGithubToken()).toBe("ghp_test123");
    });

    it("clear removes token", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setGithubToken("ghp_test123");
      store.clearGithubToken();

      expect(store.getGithubToken()).toBeNull();
    });

    it("returns null for empty string token", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "shipit-credentials.json"),
        JSON.stringify({ githubToken: "" }),
      );

      const store = new CredentialStore(dir);
      expect(store.getGithubToken()).toBeNull();
    });

    it("new instance reads back saved token", () => {
      const dir = createTmpDir();
      new CredentialStore(dir).setGithubToken("ghp_persisted");

      const store2 = new CredentialStore(dir);
      expect(store2.getGithubToken()).toBe("ghp_persisted");
    });
  });

  // ---- Cross-concern ----

  describe("mixed credentials", () => {
    it("all credential types coexist in one file", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-abc");
      store.setGithubToken("ghp_xyz");

      const raw = JSON.parse(fs.readFileSync(path.join(dir, "shipit-credentials.json"), "utf-8"));
      expect(raw).toEqual({
        agentEnv: { OPENAI_API_KEY: "sk-abc" },
        githubToken: "ghp_xyz",
      });
    });

    it("clear removes everything", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-abc");
      store.setGithubToken("ghp_xyz");

      store.clear();
      expect(store.getAgentEnv("OPENAI_API_KEY")).toBeUndefined();
      expect(store.getGithubToken()).toBeNull();
    });
  });

  // ---- Edge cases ----

  describe("edge cases", () => {
    it("handles corrupt JSON gracefully", () => {
      const dir = createTmpDir();
      fs.writeFileSync(path.join(dir, "shipit-credentials.json"), "not json{{{");

      const store = new CredentialStore(dir);
      expect(store.getGithubToken()).toBeNull();
    });

    it("creates directory if missing", () => {
      const dir = createTmpDir();
      const nested = path.join(dir, "sub", "dir");
      const store = new CredentialStore(nested);
      store.setAgentEnv("OPENAI_API_KEY", "sk-test");

      expect(fs.existsSync(path.join(nested, "shipit-credentials.json"))).toBe(true);
    });

    it("file has restrictive permissions", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setGithubToken("ghp_secret");

      const stat = fs.statSync(path.join(dir, "shipit-credentials.json"));
      // 0o600 = owner read/write only
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  // ---- MCP servers (docs/088-mcp-integration) ----

  describe("mcpServers", () => {
    const linear = {
      name: "linear",
      type: "stdio" as const,
      command: "npx",
      args: ["-y", "@anthropic-ai/linear-mcp"],
      env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
      enabled: true,
    };

    it("set/get/getAll round-trips and survives reload", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setMcpServer("linear", linear);

      expect(store.getMcpServer("linear")).toEqual(linear);
      expect(Object.keys(store.getAllMcpServers())).toEqual(["linear"]);

      const reloaded = new CredentialStore(dir);
      expect(reloaded.getMcpServer("linear")).toEqual(linear);
    });

    it("enforces config.name === key on write", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpServer("renamed", { ...linear, name: "stale" });
      expect(store.getMcpServer("renamed")?.name).toBe("renamed");
    });

    it("deleteMcpServer removes the blob but not its secrets", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpServer("linear", linear);
      store.setMcpSecret("mcp__linear__LINEAR_API_KEY", "lin_api_abc");
      store.deleteMcpServer("linear");

      expect(store.getMcpServer("linear")).toBeUndefined();
      expect(store.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBe("lin_api_abc");
    });

    it("setMcpSecret rejects non-mcp keys", () => {
      const store = new CredentialStore(createTmpDir());
      expect(() => store.setMcpSecret("OPENAI_API_KEY", "x")).toThrow(/mcp__/);
    });

    it("setMcpSecret persists mcp__* values that survive reload", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setMcpSecret("mcp__linear__LINEAR_API_KEY", "lin_api_abc");
      expect(new CredentialStore(dir).getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBe(
        "lin_api_abc",
      );
    });

    it("deleteMcpSecretsForServer clears only that server's mcp__* keys", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpSecret("mcp__linear__LINEAR_API_KEY", "a");
      store.setMcpSecret("mcp__linear__OTHER", "b");
      store.setMcpSecret("mcp__sentry__SENTRY_AUTH_TOKEN", "c");
      store.setAgentEnv("OPENAI_API_KEY", "sk");

      store.deleteMcpSecretsForServer("linear");

      expect(store.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBeUndefined();
      expect(store.getAgentEnv("mcp__linear__OTHER")).toBeUndefined();
      expect(store.getAgentEnv("mcp__sentry__SENTRY_AUTH_TOKEN")).toBe("c");
      expect(store.getAgentEnv("OPENAI_API_KEY")).toBe("sk");
    });

    it("clear() wipes both mcpServers and mcp__* secrets", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpServer("linear", linear);
      store.setMcpSecret("mcp__linear__LINEAR_API_KEY", "lin_api_abc");
      store.clear();

      expect(store.getAllMcpServers()).toEqual({});
      expect(store.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBeUndefined();
    });
  });

  // ---- MCP OAuth tokens (docs/088 Phase 2) ----

  describe("mcpOAuth", () => {
    it("setMcpOAuthTokens persists and stamps obtainedAt", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("linear_oauth", {
        accessToken: "at_xyz",
        refreshToken: "rt_xyz",
        clientId: "cid",
        expiresAt: 1_700_000_000_000,
      });
      const got = store.getMcpOAuthTokens("linear_oauth");
      expect(got?.accessToken).toBe("at_xyz");
      expect(got?.refreshToken).toBe("rt_xyz");
      expect(got?.clientId).toBe("cid");
      expect(got?.expiresAt).toBe(1_700_000_000_000);
      expect(got?.obtainedAt).toBeTruthy();
    });

    it("preserves a caller-supplied obtainedAt", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("linear_oauth", {
        accessToken: "x",
        obtainedAt: "2024-01-01T00:00:00.000Z",
      });
      expect(store.getMcpOAuthTokens("linear_oauth")?.obtainedAt).toBe(
        "2024-01-01T00:00:00.000Z",
      );
    });

    it("returns a defensive copy from get", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("linear_oauth", { accessToken: "x" });
      const got = store.getMcpOAuthTokens("linear_oauth")!;
      got.accessToken = "mutated";
      expect(store.getMcpOAuthTokens("linear_oauth")?.accessToken).toBe("x");
    });

    it("getAllMcpOAuthTokens returns a fresh per-entry copy", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("linear_oauth", { accessToken: "x" });
      store.setMcpOAuthTokens("notion_oauth", { accessToken: "y" });
      const all = store.getAllMcpOAuthTokens();
      all.linear_oauth.accessToken = "mutated";
      expect(store.getMcpOAuthTokens("linear_oauth")?.accessToken).toBe("x");
      expect(Object.keys(all).sort()).toEqual(["linear_oauth", "notion_oauth"]);
    });

    it("deleteMcpOAuthTokens removes a single source", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("linear_oauth", { accessToken: "x" });
      store.setMcpOAuthTokens("notion_oauth", { accessToken: "y" });
      store.deleteMcpOAuthTokens("linear_oauth");
      expect(store.getMcpOAuthTokens("linear_oauth")).toBeUndefined();
      expect(store.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("y");
    });

    it("survives a reload from disk", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setMcpOAuthTokens("linear_oauth", {
        accessToken: "at_xyz",
        refreshToken: "rt_xyz",
      });
      const reloaded = new CredentialStore(dir);
      expect(reloaded.getMcpOAuthTokens("linear_oauth")?.accessToken).toBe("at_xyz");
      expect(reloaded.getMcpOAuthTokens("linear_oauth")?.refreshToken).toBe("rt_xyz");
    });

    it("clear() wipes mcpOAuth tokens too", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("linear_oauth", { accessToken: "x" });
      store.clear();
      expect(store.getMcpOAuthTokens("linear_oauth")).toBeUndefined();
    });
  });

  describe("mcpOAuthClients (docs/139 — RFC 7591 DCR)", () => {
    it("stores, reads (defensive copy), and persists registered clients", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setMcpOAuthClient("notion_oauth", {
        clientId: "cid",
        clientSecret: "sec",
        registeredAt: 123,
      });
      const got = store.getMcpOAuthClient("notion_oauth")!;
      expect(got.clientId).toBe("cid");
      expect(got.clientSecret).toBe("sec");
      // Mutating the copy doesn't affect the store.
      got.clientId = "mutated";
      expect(store.getMcpOAuthClient("notion_oauth")?.clientId).toBe("cid");
      // Survives a reload.
      const reloaded = new CredentialStore(dir);
      expect(reloaded.getMcpOAuthClient("notion_oauth")?.clientId).toBe("cid");
    });

    it("returns undefined for an unregistered provider", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.getMcpOAuthClient("notion_oauth")).toBeUndefined();
    });

    it("deleteMcpOAuthClient removes only the targeted client", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthClient("notion_oauth", { clientId: "n", registeredAt: 1 });
      store.setMcpOAuthClient("linear_oauth", { clientId: "l", registeredAt: 1 });
      store.deleteMcpOAuthClient("notion_oauth");
      expect(store.getMcpOAuthClient("notion_oauth")).toBeUndefined();
      expect(store.getMcpOAuthClient("linear_oauth")?.clientId).toBe("l");
    });

    it("clear() wipes registered clients too", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthClient("notion_oauth", { clientId: "n", registeredAt: 1 });
      store.clear();
      expect(store.getMcpOAuthClient("notion_oauth")).toBeUndefined();
    });
  });
});
