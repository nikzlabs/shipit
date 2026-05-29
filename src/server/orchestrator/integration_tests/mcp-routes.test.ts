/**
 * Integration tests for /api/mcp-servers routes (docs/088-mcp-integration).
 *
 * Spins up a real Fastify app via `buildApp()` with stub managers and exercises
 * the CRUD endpoints, secret non-echo invariant, enabled-server cap, and the
 * test-endpoint "no active session" 409 path. Stays orchestrator-only — no
 * Docker, no real worker.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";
import { MAX_ENABLED_MCP_SERVERS } from "../services/mcp.js";
import {
  extractPlatformSourcesFromMcpConfig,
  registerMcpRoutes,
} from "../api-routes-mcp.js";

describe("Integration: /api/mcp-servers routes (docs/088)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-mcp-routes-"));
    initGlobalGitConfig(tmpDir);
    credentialStore = new CredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  const stdioConfig = {
    name: "linear",
    type: "stdio",
    command: "npx",
    args: ["-y", "@anthropic-ai/linear-mcp"],
    env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
    enabled: true,
  };

  const httpConfig = {
    name: "sentry",
    type: "http",
    url: "https://mcp.sentry.dev/mcp",
    headers: { Authorization: "Bearer $secret:mcp__sentry__SENTRY_TOKEN" },
    enabled: true,
  };

  // ---- GET /api/mcp-servers ----

  it("GET /api/mcp-servers returns an empty list initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp-servers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: [] });
  });

  it("GET /api/mcp-servers returns configs sorted by name", async () => {
    credentialStore.setMcpServer("zeta", { ...stdioConfig, name: "zeta" } as never);
    credentialStore.setMcpServer("alpha", { ...stdioConfig, name: "alpha" } as never);

    const res = await app.inject({ method: "GET", url: "/api/mcp-servers" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { servers: { name: string }[] };
    expect(body.servers.map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  // ---- POST /api/mcp-servers ----

  it("POST /api/mcp-servers saves config + secret, never echoes the secret value", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: {
        config: stdioConfig,
        secrets: { mcp__linear__LINEAR_API_KEY: "lin_api_supersecret" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { server: { env?: Record<string, string> } };
    // Response contains the placeholder, not the raw value.
    expect(body.server.env?.LINEAR_API_KEY).toBe(
      "$secret:mcp__linear__LINEAR_API_KEY",
    );
    // The raw secret value is stored under agentEnv but never echoed.
    expect(JSON.stringify(body)).not.toContain("lin_api_supersecret");

    // Verify the secret IS persisted in CredentialStore.agentEnv.
    expect(credentialStore.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBe(
      "lin_api_supersecret",
    );
  });

  it("POST /api/mcp-servers returns 400 for invalid names", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { config: { ...stdioConfig, name: "Bad Name!" }, secrets: {} },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/lowercase alphanumeric/);
  });

  it("POST /api/mcp-servers returns 400 for reserved names", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { config: { ...stdioConfig, name: "playwright" }, secrets: {} },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/reserved/);
  });

  it("POST /api/mcp-servers returns 409 on duplicate name", async () => {
    await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { config: stdioConfig, secrets: {} },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { config: stdioConfig, secrets: {} },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/already exists/);
  });

  it("POST /api/mcp-servers rejects secrets outside the server namespace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: {
        config: stdioConfig,
        secrets: { mcp__sentry__TOKEN: "wrong-server-key" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/namespace/);
  });

  it("POST /api/mcp-servers enforces the enabled-server cap", async () => {
    for (let i = 0; i < MAX_ENABLED_MCP_SERVERS; i++) {
      await app.inject({
        method: "POST",
        url: "/api/mcp-servers",
        payload: { config: { ...stdioConfig, name: `srv${i}` }, secrets: {} },
      });
    }
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { config: { ...stdioConfig, name: "onetoomany" }, secrets: {} },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/more than/);

    // But a *disabled* server fits past the cap.
    const ok = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: {
        config: { ...stdioConfig, name: "disabledok", enabled: false },
        secrets: {},
      },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("POST /api/mcp-servers accepts http servers with headers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: {
        config: httpConfig,
        secrets: { mcp__sentry__SENTRY_TOKEN: "sntrys_abc" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { server: { headers?: Record<string, string> } };
    expect(body.server.headers?.Authorization).toBe(
      "Bearer $secret:mcp__sentry__SENTRY_TOKEN",
    );
    // No raw value in the response body.
    expect(JSON.stringify(body)).not.toContain("sntrys_abc");
  });

  // ---- PUT /api/mcp-servers/:id ----

  it("PUT /api/mcp-servers/:id updates the config in place", async () => {
    await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { config: stdioConfig, secrets: {} },
    });

    const res = await app.inject({
      method: "PUT",
      url: "/api/mcp-servers/linear",
      payload: {
        config: { ...stdioConfig, enabled: false },
        secrets: {},
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { server: { enabled: boolean } };
    expect(body.server.enabled).toBe(false);
  });

  it("PUT /api/mcp-servers/:id renames and clears old secrets", async () => {
    await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: {
        config: stdioConfig,
        secrets: { mcp__linear__LINEAR_API_KEY: "old_value" },
      },
    });

    const renamed = {
      ...stdioConfig,
      name: "linearprod",
      env: { LINEAR_API_KEY: "$secret:mcp__linearprod__LINEAR_API_KEY" },
    };
    const res = await app.inject({
      method: "PUT",
      url: "/api/mcp-servers/linear",
      payload: {
        config: renamed,
        secrets: { mcp__linearprod__LINEAR_API_KEY: "new_value" },
      },
    });
    expect(res.statusCode).toBe(200);

    // Old keys are cleared, new ones present.
    expect(credentialStore.getMcpServer("linear")).toBeUndefined();
    expect(credentialStore.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBeUndefined();
    expect(credentialStore.getMcpServer("linearprod")?.name).toBe("linearprod");
    expect(credentialStore.getAgentEnv("mcp__linearprod__LINEAR_API_KEY")).toBe(
      "new_value",
    );
  });

  it("PUT /api/mcp-servers/:id 404s for unknown id", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/mcp-servers/nonexistent",
      payload: { config: stdioConfig, secrets: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- DELETE /api/mcp-servers/:id ----

  it("DELETE /api/mcp-servers/:id removes the blob and its secrets", async () => {
    await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: {
        config: stdioConfig,
        secrets: { mcp__linear__LINEAR_API_KEY: "lin_value" },
      },
    });
    expect(credentialStore.getMcpServer("linear")).toBeDefined();

    const res = await app.inject({
      method: "DELETE",
      url: "/api/mcp-servers/linear",
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deleted: boolean }).deleted).toBe(true);

    expect(credentialStore.getMcpServer("linear")).toBeUndefined();
    expect(credentialStore.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBeUndefined();
  });

  it("DELETE /api/mcp-servers/:id 404s for unknown id", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mcp-servers/nonexistent",
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- POST /api/mcp-servers/:id/test ----

  it("POST /api/mcp-servers/:id/test returns 409 when no session container is active", async () => {
    await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { config: stdioConfig, secrets: {} },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers/linear/test",
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/active session/i);
  });

  it("POST /api/mcp-servers/:id/test returns 404 for unknown server", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers/nonexistent/test",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("MCP route OAuth refresh retry", () => {
  it("extracts platform sources from nested MCP config placeholders", () => {
    expect(
      extractPlatformSourcesFromMcpConfig({
        headers: { Authorization: "Bearer $platform:linear_oauth" },
        args: ["--token=$platform:notion_oauth"],
      }),
    ).toEqual(["linear_oauth", "notion_oauth"]);
  });

  it("refreshes a rejected OAuth token, pushes agent env, and retries the test once", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-mcp-refresh-route-"));
    const credentialStore = new CredentialStore(tmpDir);
    credentialStore.setMcpServer("linear", {
      name: "linear",
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer $platform:linear_oauth" },
      enabled: true,
    });
    credentialStore.setMcpOAuthTokens("linear_oauth", {
      accessToken: "old_access",
      refreshToken: "refresh_1",
      clientId: "client_1",
    });

    const pushed: Record<string, string>[] = [];
    let attempts = 0;
    const runner = {
      serviceManager: null,
      async tryPushAgentSecrets(values: Record<string, string>) {
        pushed.push(values);
      },
      async proxyMcpTest() {
        attempts += 1;
        if (attempts === 1) return { ok: false, error: "HTTP 401 Unauthorized" };
        return pushed.at(-1)?.MCP_PLATFORM_LINEAR_OAUTH === "new_access"
          ? { ok: true, tools: [{ name: "linear_search" }] }
          : { ok: false, error: "still stale" };
      },
    };
    const runnerRegistry = {
      ids: () => ["s1"],
      get: () => runner,
    };
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const params = new URLSearchParams(body);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("refresh_1");
      return new Response(
        JSON.stringify({ access_token: "new_access", token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const app = Fastify({ logger: false });
    await registerMcpRoutes(app, {
      credentialStore,
      runnerRegistry: runnerRegistry as never,
      serviceManagers: new Map(),
      oauthFetchImpl: fetchImpl,
    });

    try {
      const res = await app.inject({ method: "POST", url: "/api/mcp-servers/linear/test" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, tools: [{ name: "linear_search" }] });
      expect(attempts).toBe(2);
      expect(credentialStore.getMcpOAuthTokens("linear_oauth")?.accessToken).toBe("new_access");
      expect(pushed).toHaveLength(1);
      expect(pushed[0].MCP_PLATFORM_LINEAR_OAUTH).toBe("new_access");
    } finally {
      await app.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
