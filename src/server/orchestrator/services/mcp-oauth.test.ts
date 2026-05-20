/**
 * Unit tests for the MCP OAuth service (docs/088 Phase 2, docs/139 DCR).
 *
 * Covers:
 *   - PKCE start: returns a well-formed authorize URL, persists state.
 *   - Discovery-driven endpoints + RFC 7591 dynamic client registration
 *     (docs/139): register on first connect, cache, reuse, env override wins,
 *     exchange at the *discovered* token endpoint (the actual bug fixed).
 *   - Callback: exchanges code, normalizes the token response, persists tokens.
 *   - Refresh: uses the stored refresh token, carries it forward when the
 *     provider doesn't reissue.
 *   - Background refresh: only touches tokens within the safety margin,
 *     reports refreshed + failed.
 *   - Disconnect: removes tokens, keeps the cached client.
 *
 * The `fetch` boundary is faked — none of the tests touch the network.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import {
  InMemoryOAuthStateStore,
  startOAuthFlow,
  handleOAuthCallback,
  refreshOAuthTokens,
  refreshExpiredMcpOAuthTokens,
  listMcpOAuthProviders,
  disconnectMcpOAuth,
  normalizeTokenResponse,
} from "./mcp-oauth.js";
import { _clearDiscoveryCache } from "./mcp-oauth-discovery.js";
import { ServiceError } from "./types.js";

/**
 * A `fetch` stub that fails all discovery probes (404) so a flow falls back to
 * the registry endpoints. Use for Linear (no DCR) tests where we only care
 * about the authorize URL / state.
 */
const discoveryFails404: typeof fetch = async () =>
  new Response("not found", { status: 404 });

/**
 * Build a `fetch` stub that serves the Notion DCR discovery chain + a
 * registration response, recording every request URL. Token exchange is left
 * to the caller's `handleOAuthCallback` fetch.
 */
function makeNotionDiscoveryFetch(opts?: {
  clientId?: string;
  /** Override the registration response status (default 201). */
  registerStatus?: number;
  /** Override the registration response body. */
  registerBody?: unknown;
}): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const clientId = opts?.clientId ?? "issued_client_id";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    // 1. Unauthenticated probe → 401 with WWW-Authenticate.
    if (url === "https://mcp.notion.com/mcp" && init?.method === "POST") {
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
        },
      });
    }
    // 2. Protected-resource metadata.
    if (url === "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp") {
      return new Response(
        JSON.stringify({
          resource: "https://mcp.notion.com",
          authorization_servers: ["https://mcp.notion.com"],
        }),
        { status: 200 },
      );
    }
    // 3. Authorization-server metadata (RFC 8414).
    if (url === "https://mcp.notion.com/.well-known/oauth-authorization-server") {
      return new Response(
        JSON.stringify({
          issuer: "https://mcp.notion.com",
          authorization_endpoint: "https://mcp.notion.com/authorize",
          token_endpoint: "https://mcp.notion.com/token",
          registration_endpoint: "https://mcp.notion.com/register",
          code_challenge_methods_supported: ["plain", "S256"],
        }),
        { status: 200 },
      );
    }
    // 4. Dynamic client registration.
    if (url === "https://mcp.notion.com/register") {
      return new Response(
        JSON.stringify(opts?.registerBody ?? { client_id: clientId }),
        { status: opts?.registerStatus ?? 201 },
      );
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, urls };
}

describe("services/mcp-oauth (docs/088 Phase 2, docs/139 DCR)", () => {
  let tmpDir: string;
  let store: CredentialStore;
  let stateStore: InMemoryOAuthStateStore;
  const REDIRECT = "https://shipit.example.com/api/mcp-servers/oauth/callback";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-"));
    store = new CredentialStore(tmpDir);
    stateStore = new InMemoryOAuthStateStore();
    _clearDiscoveryCache();
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("startOAuthFlow", () => {
    it("returns an authorize URL with PKCE + state and persists flow state", async () => {
      const result = await startOAuthFlow({
        source: "linear_oauth",
        stateStore,
        redirectUri: REDIRECT,
        credentialStore: store,
        env: { LINEAR_OAUTH_CLIENT_ID: "test-client-id" },
        fetchImpl: discoveryFails404,
      });
      const url = new URL(result.authorizeUrl);
      expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("test-client-id");
      expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(url.searchParams.get("state")).toBe(result.state);
      // Scopes are joined with spaces
      expect(url.searchParams.get("scope")).toContain("read");
      // State store now has the flow
      expect(stateStore.size()).toBe(1);
    });

    it("throws 404 for unknown provider", async () => {
      await expect(
        startOAuthFlow({
          source: "unknown_provider",
          stateStore,
          redirectUri: REDIRECT,
          credentialStore: store,
          env: {},
          fetchImpl: discoveryFails404,
        }),
      ).rejects.toThrow(ServiceError);
    });

    it("throws 400 when no client id, no DCR endpoint, and no env var (Linear)", async () => {
      try {
        await startOAuthFlow({
          source: "linear_oauth",
          stateStore,
          redirectUri: REDIRECT,
          credentialStore: store,
          env: {},
          fetchImpl: discoveryFails404,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).statusCode).toBe(400);
        expect((err as ServiceError).message).toContain("LINEAR_OAUTH_CLIENT_ID");
      }
    });
  });

  describe("startOAuthFlow — dynamic client registration (docs/139)", () => {
    it("discovers endpoints, registers a client, caches it, and points the authorize URL at the discovered endpoint", async () => {
      const { fetchImpl, urls } = makeNotionDiscoveryFetch({ clientId: "dcr_cid" });
      const result = await startOAuthFlow({
        source: "notion_oauth",
        stateStore,
        redirectUri: REDIRECT,
        credentialStore: store,
        env: {},
        fetchImpl,
      });
      const url = new URL(result.authorizeUrl);
      // Authorize URL points at the *discovered* endpoint.
      expect(url.origin + url.pathname).toBe("https://mcp.notion.com/authorize");
      expect(url.searchParams.get("client_id")).toBe("dcr_cid");
      // Registration was performed.
      expect(urls).toContain("https://mcp.notion.com/register");
      // Client cached for reuse.
      expect(store.getMcpOAuthClient("notion_oauth")?.clientId).toBe("dcr_cid");
    });

    it("reuses a cached registered client and skips /register", async () => {
      store.setMcpOAuthClient("notion_oauth", {
        clientId: "cached_cid",
        registeredAt: Date.now(),
      });
      const { fetchImpl, urls } = makeNotionDiscoveryFetch({ clientId: "should_not_be_used" });
      const result = await startOAuthFlow({
        source: "notion_oauth",
        stateStore,
        redirectUri: REDIRECT,
        credentialStore: store,
        env: {},
        fetchImpl,
      });
      expect(new URL(result.authorizeUrl).searchParams.get("client_id")).toBe("cached_cid");
      expect(urls).not.toContain("https://mcp.notion.com/register");
    });

    it("operator env-var override wins over registration", async () => {
      const { fetchImpl, urls } = makeNotionDiscoveryFetch();
      const result = await startOAuthFlow({
        source: "notion_oauth",
        stateStore,
        redirectUri: REDIRECT,
        credentialStore: store,
        env: { NOTION_OAUTH_CLIENT_ID: "operator_cid" },
        fetchImpl,
      });
      expect(new URL(result.authorizeUrl).searchParams.get("client_id")).toBe("operator_cid");
      expect(urls).not.toContain("https://mcp.notion.com/register");
      // No client persisted to the cache — the override is per-process.
      expect(store.getMcpOAuthClient("notion_oauth")).toBeUndefined();
    });

    it("surfaces a 502 when /register returns a 4xx", async () => {
      const { fetchImpl } = makeNotionDiscoveryFetch({
        registerStatus: 429,
        registerBody: { error: "rate_limited" },
      });
      try {
        await startOAuthFlow({
          source: "notion_oauth",
          stateStore,
          redirectUri: REDIRECT,
          credentialStore: store,
          env: {},
          fetchImpl,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).statusCode).toBe(502);
        // Hints at the env-var fallback.
        expect((err as ServiceError).message).toContain("NOTION_OAUTH_CLIENT_ID");
      }
    });
  });

  describe("handleOAuthCallback", () => {
    it("exchanges code for tokens and persists with obtainedAt stamped", async () => {
      const { state } = await startOAuthFlow({
        source: "linear_oauth",
        stateStore,
        redirectUri: REDIRECT,
        credentialStore: store,
        env: { LINEAR_OAUTH_CLIENT_ID: "cid" },
        fetchImpl: discoveryFails404,
      });

      const fakeFetch: typeof fetch = async (input: unknown, init: unknown) => {
        const body = ((init as { body?: string })?.body ?? "") as string;
        const params = new URLSearchParams(body);
        expect(input).toBe("https://api.linear.app/oauth/token");
        expect(params.get("grant_type")).toBe("authorization_code");
        expect(params.get("code")).toBe("the-code");
        expect(params.get("client_id")).toBe("cid");
        expect(params.get("code_verifier")).toBeTruthy();
        return new Response(
          JSON.stringify({
            access_token: "at_abc",
            refresh_token: "rt_abc",
            expires_in: 3600,
            scope: "read write",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const result = await handleOAuthCallback({
        input: { state, code: "the-code" },
        stateStore,
        credentialStore: store,
        fetchImpl: fakeFetch,
      });
      expect(result.source).toBe("linear_oauth");
      const persisted = store.getMcpOAuthTokens("linear_oauth");
      expect(persisted?.accessToken).toBe("at_abc");
      expect(persisted?.refreshToken).toBe("rt_abc");
      expect(persisted?.scope).toBe("read write");
      expect(persisted?.clientId).toBe("cid");
      expect(persisted?.obtainedAt).toBeTruthy();
      // expires_in: 3600 → expiresAt ~ now + 1h
      expect(persisted?.expiresAt).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
      // State was consumed (single-use)
      expect(stateStore.size()).toBe(0);
    });

    it("exchanges at the DISCOVERED token endpoint, not the registry value (docs/139 bug fix)", async () => {
      const { fetchImpl } = makeNotionDiscoveryFetch({ clientId: "dcr_cid" });
      const { state } = await startOAuthFlow({
        source: "notion_oauth",
        stateStore,
        redirectUri: REDIRECT,
        credentialStore: store,
        env: {},
        fetchImpl,
      });

      let exchangedAt = "";
      const exchangeFetch: typeof fetch = async (input: unknown) => {
        exchangedAt = String(input);
        return new Response(
          JSON.stringify({ access_token: "notion_at", token_type: "Bearer" }),
          { status: 200 },
        );
      };
      await handleOAuthCallback({
        input: { state, code: "code123" },
        stateStore,
        credentialStore: store,
        fetchImpl: exchangeFetch,
      });
      // The discovered mcp.notion.com/token — never the old api.notion.com one.
      expect(exchangedAt).toBe("https://mcp.notion.com/token");
      expect(exchangedAt).not.toContain("api.notion.com");
      expect(store.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("notion_at");
      // clientId carried into the stored tokens for the refresh path.
      expect(store.getMcpOAuthTokens("notion_oauth")?.clientId).toBe("dcr_cid");
    });

    it("rejects an unknown state with 400 (covers CSRF)", async () => {
      await expect(
        handleOAuthCallback({
          input: { state: "never-issued", code: "x" },
          stateStore,
          credentialStore: store,
          fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
        }),
      ).rejects.toThrow(/unknown or expired/);
    });

    it("propagates a non-2xx response with body content in the error", async () => {
      const { state } = await startOAuthFlow({
        source: "linear_oauth",
        stateStore,
        redirectUri: REDIRECT,
        credentialStore: store,
        env: { LINEAR_OAUTH_CLIENT_ID: "cid" },
        fetchImpl: discoveryFails404,
      });
      const fakeFetch: typeof fetch = async () =>
        new Response('{"error":"invalid_grant"}', { status: 400 });
      await expect(
        handleOAuthCallback({
          input: { state, code: "x" },
          stateStore,
          credentialStore: store,
          fetchImpl: fakeFetch,
        }),
      ).rejects.toThrow(/400/);
    });
  });

  describe("refreshOAuthTokens", () => {
    it("uses the stored refresh token and persists the new access token", async () => {
      store.setMcpOAuthTokens("linear_oauth", {
        accessToken: "old",
        refreshToken: "rt1",
        clientId: "cid",
        expiresAt: Date.now() - 1000,
      });
      const fakeFetch: typeof fetch = async (input: unknown, init: unknown) => {
        const body = ((init as { body?: string })?.body ?? "") as string;
        const params = new URLSearchParams(body);
        expect(input).toBe("https://api.linear.app/oauth/token");
        expect(params.get("grant_type")).toBe("refresh_token");
        expect(params.get("refresh_token")).toBe("rt1");
        return new Response(
          JSON.stringify({
            access_token: "new_at",
            // Notion-style: no refresh_token reissued
            expires_in: 7200,
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      };
      const next = await refreshOAuthTokens({
        source: "linear_oauth",
        credentialStore: store,
        fetchImpl: fakeFetch,
      });
      expect(next.accessToken).toBe("new_at");
      // Old refresh token carries forward when provider didn't reissue.
      expect(next.refreshToken).toBe("rt1");
      const persisted = store.getMcpOAuthTokens("linear_oauth");
      expect(persisted?.accessToken).toBe("new_at");
      expect(persisted?.refreshToken).toBe("rt1");
    });

    it("refreshes Notion at the corrected registry endpoint (mcp.notion.com/token)", async () => {
      store.setMcpOAuthTokens("notion_oauth", {
        accessToken: "old",
        refreshToken: "rt1",
        clientId: "cid",
        expiresAt: Date.now() - 1000,
      });
      let refreshedAt = "";
      const fakeFetch: typeof fetch = async (input: unknown) => {
        refreshedAt = String(input);
        return new Response(
          JSON.stringify({ access_token: "new_at", token_type: "Bearer" }),
          { status: 200 },
        );
      };
      await refreshOAuthTokens({
        source: "notion_oauth",
        credentialStore: store,
        fetchImpl: fakeFetch,
      });
      expect(refreshedAt).toBe("https://mcp.notion.com/token");
      expect(refreshedAt).not.toContain("api.notion.com");
    });

    it("throws when no refresh token is on file", async () => {
      store.setMcpOAuthTokens("linear_oauth", {
        accessToken: "x",
        clientId: "cid",
      });
      await expect(
        refreshOAuthTokens({
          source: "linear_oauth",
          credentialStore: store,
          fetchImpl: (async () => new Response("{}")) as typeof fetch,
        }),
      ).rejects.toThrow(/refresh token/);
    });

    it("throws for unknown providers", async () => {
      await expect(
        refreshOAuthTokens({
          source: "wat",
          credentialStore: store,
          fetchImpl: (async () => new Response("{}")) as typeof fetch,
        }),
      ).rejects.toThrow(/Unknown MCP OAuth provider/);
    });
  });

  describe("refreshExpiredMcpOAuthTokens", () => {
    it("only refreshes tokens within the safety margin; reports both buckets", async () => {
      const now = 1_700_000_000_000;
      store.setMcpOAuthTokens("linear_oauth", {
        accessToken: "fresh",
        refreshToken: "rt-fresh",
        clientId: "cid",
        expiresAt: now + 60 * 60 * 1000, // 1h out — safe
      });
      store.setMcpOAuthTokens("notion_oauth", {
        accessToken: "old",
        refreshToken: "rt-old",
        clientId: "cid2",
        expiresAt: now + 60 * 1000, // 1min out — within safety margin
      });
      let calls = 0;
      const fakeFetch: typeof fetch = async () => {
        calls++;
        return new Response(
          JSON.stringify({ access_token: "rotated", expires_in: 3600 }),
          { status: 200 },
        );
      };
      const result = await refreshExpiredMcpOAuthTokens({
        credentialStore: store,
        safetyMarginMs: 5 * 60 * 1000,
        now: () => now,
        fetchImpl: fakeFetch,
      });
      expect(result.refreshed).toEqual(["notion_oauth"]);
      expect(result.failed).toEqual([]);
      expect(calls).toBe(1);
      expect(store.getMcpOAuthTokens("linear_oauth")?.accessToken).toBe("fresh");
      expect(store.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("rotated");
    });

    it("skips tokens with no expiresAt (Notion-style non-expiring workspace tokens)", async () => {
      store.setMcpOAuthTokens("notion_oauth", {
        accessToken: "wat",
        clientId: "cid",
      });
      const fakeFetch: typeof fetch = async () => {
        throw new Error("should not be called");
      };
      const result = await refreshExpiredMcpOAuthTokens({
        credentialStore: store,
        fetchImpl: fakeFetch,
      });
      expect(result.refreshed).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it("records failed sources without throwing", async () => {
      store.setMcpOAuthTokens("linear_oauth", {
        accessToken: "x",
        // No refresh token — refresh path is going to fail.
        clientId: "cid",
        expiresAt: Date.now() - 1000,
      });
      const result = await refreshExpiredMcpOAuthTokens({
        credentialStore: store,
        fetchImpl: (async () => new Response("{}")) as typeof fetch,
      });
      expect(result.refreshed).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].source).toBe("linear_oauth");
    });
  });

  describe("normalizeTokenResponse", () => {
    it("handles expires_in (seconds)", () => {
      const t = normalizeTokenResponse({
        access_token: "x",
        expires_in: 3600,
        refresh_token: "r",
      });
      expect(t.accessToken).toBe("x");
      expect(t.refreshToken).toBe("r");
      expect(t.expiresAt).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    });

    it("handles expires_at as unix seconds", () => {
      const t = normalizeTokenResponse({
        access_token: "x",
        expires_at: 1_700_000_000, // year 2023, unambiguously seconds
      });
      expect(t.expiresAt).toBe(1_700_000_000_000);
    });

    it("handles expires_at as unix millis (already past 10^12)", () => {
      const t = normalizeTokenResponse({
        access_token: "x",
        expires_at: 2_000_000_000_000,
      });
      expect(t.expiresAt).toBe(2_000_000_000_000);
    });

    it("throws on missing access_token", () => {
      expect(() => normalizeTokenResponse({ refresh_token: "r" })).toThrow(
        /missing access_token/,
      );
    });

    it("carries client id/secret context when supplied", () => {
      const t = normalizeTokenResponse(
        { access_token: "x" },
        { clientId: "cid", clientSecret: "sec" },
      );
      expect(t.clientId).toBe("cid");
      expect(t.clientSecret).toBe("sec");
    });
  });

  describe("listMcpOAuthProviders + disconnectMcpOAuth", () => {
    it("includes both connected and disconnected providers", () => {
      store.setMcpOAuthTokens("linear_oauth", {
        accessToken: "x",
        clientId: "cid",
        scope: "read",
      });
      const list = listMcpOAuthProviders(store);
      const linear = list.find((p) => p.provider.id === "linear_oauth");
      const notion = list.find((p) => p.provider.id === "notion_oauth");
      expect(linear?.status.connected).toBe(true);
      expect(linear?.status.scope).toBe("read");
      expect(notion?.status.connected).toBe(false);
    });

    it("a cached registered client alone does NOT show as connected", () => {
      // docs/139: client storage is separate from token storage precisely so
      // a registered-but-not-authorized client never shows "Connected".
      store.setMcpOAuthClient("notion_oauth", {
        clientId: "cid",
        registeredAt: Date.now(),
      });
      const notion = listMcpOAuthProviders(store).find(
        (p) => p.provider.id === "notion_oauth",
      );
      expect(notion?.status.connected).toBe(false);
    });

    it("disconnect removes tokens but keeps the cached client (reconnect skips re-registration)", () => {
      store.setMcpOAuthClient("notion_oauth", {
        clientId: "cid",
        registeredAt: Date.now(),
      });
      store.setMcpOAuthTokens("notion_oauth", { accessToken: "x", clientId: "cid" });
      disconnectMcpOAuth(store, "notion_oauth");
      expect(store.getMcpOAuthTokens("notion_oauth")).toBeUndefined();
      // Client survives so a reconnect reuses it.
      expect(store.getMcpOAuthClient("notion_oauth")?.clientId).toBe("cid");
    });

    it("disconnect throws 404 for unknown providers", () => {
      try {
        disconnectMcpOAuth(store, "wat");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).statusCode).toBe(404);
      }
    });
  });

  describe("InMemoryOAuthStateStore TTL", () => {
    it("evicts expired entries on read", () => {
      stateStore.put("s1", {
        source: "linear_oauth",
        codeVerifier: "v",
        redirectUri: REDIRECT,
        clientId: "cid",
        authorizationEndpoint: "https://linear.app/oauth/authorize",
        tokenEndpoint: "https://api.linear.app/oauth/token",
        createdAt: Date.now() - 11 * 60 * 1000, // older than 10min TTL
      });
      stateStore.put("s2", {
        source: "linear_oauth",
        codeVerifier: "v",
        redirectUri: REDIRECT,
        clientId: "cid",
        authorizationEndpoint: "https://linear.app/oauth/authorize",
        tokenEndpoint: "https://api.linear.app/oauth/token",
        createdAt: Date.now(),
      });
      // s1 should be gone after eviction
      expect(stateStore.take("s1")).toBeUndefined();
      expect(stateStore.take("s2")).toBeTruthy();
    });

    it("take is single-use", () => {
      stateStore.put("s", {
        source: "linear_oauth",
        codeVerifier: "v",
        redirectUri: REDIRECT,
        clientId: "cid",
        authorizationEndpoint: "https://linear.app/oauth/authorize",
        tokenEndpoint: "https://api.linear.app/oauth/token",
        createdAt: Date.now(),
      });
      expect(stateStore.take("s")).toBeTruthy();
      expect(stateStore.take("s")).toBeUndefined();
    });
  });
});
