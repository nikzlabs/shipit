/**
 * Integration tests for the MCP OAuth routes (docs/088-mcp-integration Phase 2).
 *
 * Spins up a Fastify app via `buildApp()` with a stub `fetch` to capture
 * token-endpoint requests and asserts the full lifecycle:
 *
 *   1. GET /api/mcp-servers/oauth/providers returns the registered providers.
 *   2. POST /api/mcp-servers/oauth/start returns an authorize URL with PKCE.
 *   3. GET /api/mcp-servers/oauth/callback exchanges code → tokens, persists,
 *      and emits the close-the-popup HTML.
 *   4. The persisted token is surfaced through the providers endpoint as
 *      "connected" and never echoed.
 *   5. DELETE /api/mcp-servers/oauth/:source removes the token.
 *   6. Start failures: missing client_id env, unknown provider.
 *
 * Stays orchestrator-only — no Docker, no real session worker.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
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

describe("Integration: MCP OAuth routes (docs/088 Phase 2)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  /** Records every fetch call so assertions can verify wire-level behavior. */
  let fetchCalls: { url: string; body: string }[];
  /** Programmable next response for the fake fetch. */
  let nextFetchResponse: () => Response;

  const originalLinearClientId = process.env.LINEAR_OAUTH_CLIENT_ID;

  beforeEach(async () => {
    process.env.LINEAR_OAUTH_CLIENT_ID = "test-client-id";
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-mcp-oauth-routes-"));
    initGlobalGitConfig(tmpDir);
    credentialStore = new CredentialStore(tmpDir);

    fetchCalls = [];
    nextFetchResponse = () =>
      new Response(
        JSON.stringify({
          access_token: "lin_access_xyz",
          refresh_token: "lin_refresh_xyz",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "read write",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const fakeFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const rawBody = init?.body;
      const body =
        typeof rawBody === "string"
          ? rawBody
          : rawBody instanceof URLSearchParams
            ? rawBody.toString()
            : "";
      fetchCalls.push({ url, body });
      // Discovery probes (the unauthenticated `mcpUrl` POST and the
      // `.well-known` metadata GETs) return 404 so discovery fails fast and
      // the Linear flow falls back to the registry endpoints. The token
      // exchange (api.linear.app) is the only call that returns a token body.
      if (url.includes("/.well-known/") || url.endsWith("/mcp")) {
        return new Response("not found", { status: 404 });
      }
      return nextFetchResponse();
    };

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore,
      workspaceDir: tmpDir,
      serveStatic: false,
      mcpOAuthFetchImpl: fakeFetch,
    });
  });

  afterEach(async () => {
    if (originalLinearClientId === undefined) {
      delete process.env.LINEAR_OAUTH_CLIENT_ID;
    } else {
      process.env.LINEAR_OAUTH_CLIENT_ID = originalLinearClientId;
    }
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  // -------------------------------------------------------------------------
  // Provider listing
  // -------------------------------------------------------------------------

  it("GET /api/mcp-servers/oauth/providers lists providers with connection state", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp-servers/oauth/providers" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      providers: { id: string; label: string; status: { connected: boolean } }[];
    };
    const ids = body.providers.map((p) => p.id);
    expect(ids).toContain("linear_oauth");
    expect(ids).toContain("notion_oauth");
    expect(body.providers.every((p) => !p.status.connected)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Start flow
  // -------------------------------------------------------------------------

  it("POST /api/mcp-servers/oauth/start returns a PKCE authorize URL", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers/oauth/start",
      payload: {
        source: "linear_oauth",
        redirectUri: "https://shipit.test/api/mcp-servers/oauth/callback",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { authorizeUrl: string; state: string };
    const url = new URL(body.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(body.state);
  });

  it("POST start returns 400 when LINEAR_OAUTH_CLIENT_ID is unset", async () => {
    delete process.env.LINEAR_OAUTH_CLIENT_ID;
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers/oauth/start",
      payload: { source: "linear_oauth", redirectUri: "https://shipit.test/cb" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("LINEAR_OAUTH_CLIENT_ID");
  });

  it("POST start returns 404 for unknown provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers/oauth/start",
      payload: { source: "definitely_not_a_provider", redirectUri: "https://shipit.test/cb" },
    });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Callback (full happy path)
  // -------------------------------------------------------------------------

  it("GET /callback exchanges code, persists tokens, and renders close-popup HTML", async () => {
    const startRes = await app.inject({
      method: "POST",
      url: "/api/mcp-servers/oauth/start",
      payload: { source: "linear_oauth", redirectUri: "https://shipit.test/cb" },
    });
    const { state } = startRes.json() as { state: string };

    const cbRes = await app.inject({
      method: "GET",
      url: `/api/mcp-servers/oauth/callback?code=ac_xxx&state=${encodeURIComponent(state)}`,
    });
    expect(cbRes.statusCode).toBe(200);
    expect(cbRes.headers["content-type"]).toContain("text/html");
    const html = cbRes.body;
    expect(html).toContain("Connected");
    // Posts a structured message back to the opener
    expect(html).toContain("shipit-mcp-oauth-result");
    expect(html).toContain('"ok":true');
    expect(html).toContain('"source":"linear_oauth"');

    // Verify the fake fetch saw a code-exchange call (discovery probes 404 and
    // are filtered out — Linear falls back to the registry token endpoint).
    const tokenCalls = fetchCalls.filter(
      (c) => c.url === "https://api.linear.app/oauth/token",
    );
    expect(tokenCalls).toHaveLength(1);
    const sent = new URLSearchParams(tokenCalls[0].body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("ac_xxx");
    expect(sent.get("client_id")).toBe("test-client-id");
    expect(sent.get("code_verifier")).toBeTruthy();

    // Token was persisted to CredentialStore
    const tokens = credentialStore.getMcpOAuthTokens("linear_oauth");
    expect(tokens?.accessToken).toBe("lin_access_xyz");
    expect(tokens?.refreshToken).toBe("lin_refresh_xyz");

    // Provider listing flips to connected — and the raw token is NOT echoed.
    const listRes = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/oauth/providers",
    });
    const listed = listRes.json() as {
      providers: { id: string; status: { connected: boolean } }[];
    };
    const linear = listed.providers.find((p) => p.id === "linear_oauth");
    expect(linear?.status.connected).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("lin_access_xyz");
    expect(JSON.stringify(listed)).not.toContain("lin_refresh_xyz");
  });

  it("GET /callback renders error HTML when state is unknown", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/oauth/callback?code=x&state=never-issued",
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('"ok":false');
    expect(res.body).toContain("unknown or expired");
  });

  it("GET /callback renders friendly error when the provider returns ?error=", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/oauth/callback?error=access_denied&error_description=User%20denied",
    });
    // Provider-side error — we still render HTML, just with ok=false.
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('"ok":false');
    expect(res.body).toContain("User denied");
  });

  it("GET /callback surfaces a non-2xx token-endpoint response", async () => {
    nextFetchResponse = () =>
      new Response('{"error":"invalid_grant"}', { status: 400 });

    const startRes = await app.inject({
      method: "POST",
      url: "/api/mcp-servers/oauth/start",
      payload: { source: "linear_oauth", redirectUri: "https://shipit.test/cb" },
    });
    const { state } = startRes.json() as { state: string };

    const cbRes = await app.inject({
      method: "GET",
      url: `/api/mcp-servers/oauth/callback?code=bad&state=${encodeURIComponent(state)}`,
    });
    expect(cbRes.statusCode).toBe(500);
    expect(cbRes.body).toContain('"ok":false');
    expect(credentialStore.getMcpOAuthTokens("linear_oauth")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  it("DELETE /:source removes the persisted tokens", async () => {
    credentialStore.setMcpOAuthTokens("linear_oauth", {
      accessToken: "to_be_removed",
    });
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mcp-servers/oauth/linear_oauth",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(credentialStore.getMcpOAuthTokens("linear_oauth")).toBeUndefined();
  });

  it("DELETE returns 404 for unknown provider", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/mcp-servers/oauth/no_such_provider",
    });
    expect(res.statusCode).toBe(404);
  });
});
