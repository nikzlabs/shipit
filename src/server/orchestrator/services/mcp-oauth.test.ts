/**
 * Unit tests for the MCP OAuth service (docs/088 Phase 2).
 *
 * Covers:
 *   - PKCE start: returns a well-formed authorize URL, persists state.
 *   - Callback: exchanges code, normalizes the token response, persists tokens.
 *   - Refresh: uses the stored refresh token, carries it forward when the
 *     provider doesn't reissue.
 *   - Background refresh: only touches tokens within the safety margin,
 *     reports refreshed + failed.
 *   - Disconnect: removes tokens.
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
import { ServiceError } from "./types.js";

describe("services/mcp-oauth (docs/088 Phase 2)", () => {
  let tmpDir: string;
  let store: CredentialStore;
  let stateStore: InMemoryOAuthStateStore;
  const REDIRECT = "https://shipit.example.com/api/mcp-servers/oauth/callback";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-"));
    store = new CredentialStore(tmpDir);
    stateStore = new InMemoryOAuthStateStore();
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("startOAuthFlow", () => {
    it("returns an authorize URL with PKCE + state and persists flow state", () => {
      const result = startOAuthFlow({
        source: "linear_oauth",
        stateStore,
        redirectUri: REDIRECT,
        env: { LINEAR_OAUTH_CLIENT_ID: "test-client-id" },
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

    it("throws 404 for unknown provider", () => {
      expect(() =>
        startOAuthFlow({
          source: "unknown_provider",
          stateStore,
          redirectUri: REDIRECT,
          env: {},
        }),
      ).toThrow(ServiceError);
    });

    it("throws 400 when the operator hasn't supplied the client id env var", () => {
      try {
        startOAuthFlow({
          source: "linear_oauth",
          stateStore,
          redirectUri: REDIRECT,
          env: {},
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).statusCode).toBe(400);
        expect((err as ServiceError).message).toContain("LINEAR_OAUTH_CLIENT_ID");
      }
    });
  });

  describe("handleOAuthCallback", () => {
    it("exchanges code for tokens and persists with obtainedAt stamped", async () => {
      const { state } = startOAuthFlow({
        source: "linear_oauth",
        stateStore,
        redirectUri: REDIRECT,
        env: { LINEAR_OAUTH_CLIENT_ID: "cid" },
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
      const { state } = startOAuthFlow({
        source: "linear_oauth",
        stateStore,
        redirectUri: REDIRECT,
        env: { LINEAR_OAUTH_CLIENT_ID: "cid" },
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

    it("disconnect removes tokens", () => {
      store.setMcpOAuthTokens("linear_oauth", { accessToken: "x" });
      disconnectMcpOAuth(store, "linear_oauth");
      expect(store.getMcpOAuthTokens("linear_oauth")).toBeUndefined();
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
        createdAt: Date.now() - 11 * 60 * 1000, // older than 10min TTL
      });
      stateStore.put("s2", {
        source: "linear_oauth",
        codeVerifier: "v",
        redirectUri: REDIRECT,
        clientId: "cid",
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
        createdAt: Date.now(),
      });
      expect(stateStore.take("s")).toBeTruthy();
      expect(stateStore.take("s")).toBeUndefined();
    });
  });
});
