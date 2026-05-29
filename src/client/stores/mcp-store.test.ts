/**
 * Unit tests for useMcpStore (docs/088).
 *
 * Verifies the round-trip behavior of CRUD actions against /api/mcp-servers,
 * the `mcp_server_status` event integration via applyStatus(), and the error
 * surfacing pattern.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useMcpStore } from "./mcp-store.js";
import type { McpServerConfig, McpTestResult } from "../../server/shared/types.js";

interface FakeRoute {
  matches: (method: string, url: string) => boolean;
  respond: (body: unknown) => { status?: number; body: unknown };
}

class FakeFetch {
  routes: FakeRoute[] = [];
  calls: { method: string; url: string; body?: unknown }[] = [];

  on(
    method: string,
    urlOrRegex: string | RegExp,
    respond: (body: unknown) => unknown,
  ): this {
    this.routes.push({
      matches: (m, u) => {
        if (m !== method) return false;
        return typeof urlOrRegex === "string" ? u === urlOrRegex : urlOrRegex.test(u);
      },
      respond: (body) => {
        const r = respond(body) as { status?: number; body: unknown };
        if (r && typeof r === "object" && "body" in r) return r;
        return { status: 200, body: r };
      },
    });
    return this;
  }

  install(): void {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
      this.calls.push({ method, url, body });
      const route = this.routes.find((r) => r.matches(method, url));
      if (!route) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "no fake route" }), { status: 404 }),
        );
      }
      const { status = 200, body: respBody } = route.respond(body);
      return Promise.resolve(new Response(JSON.stringify(respBody), { status }));
    }) as typeof fetch;
  }
}

const stdioConfig: McpServerConfig = {
  name: "linear",
  type: "stdio",
  command: "npx",
  args: ["-y", "@anthropic-ai/linear-mcp"],
  env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
  enabled: true,
};

const sentryConfig: McpServerConfig = {
  name: "sentry",
  type: "http",
  url: "https://mcp.sentry.dev/mcp",
  headers: { Authorization: "Bearer $secret:mcp__sentry__SENTRY_TOKEN" },
  enabled: true,
};

const originalFetch = globalThis.fetch;

describe("mcp-store (docs/088)", () => {
  beforeEach(() => {
    useMcpStore.getState().reset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetchServers() populates the store from /api/mcp-servers", async () => {
    const fake = new FakeFetch();
    fake.on("GET", "/api/mcp-servers", () => ({ servers: [stdioConfig, sentryConfig] }));
    fake.install();

    await useMcpStore.getState().fetchServers();
    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual([
      "linear",
      "sentry",
    ]);
    expect(useMcpStore.getState().loading).toBe(false);
    expect(useMcpStore.getState().error).toBeNull();
  });

  it("fetchServers() surfaces errors and clears loading", async () => {
    const fake = new FakeFetch();
    fake.on("GET", "/api/mcp-servers", () => ({
      status: 500,
      body: { error: "boom" },
    }));
    fake.install();

    await useMcpStore.getState().fetchServers();
    expect(useMcpStore.getState().loading).toBe(false);
    expect(useMcpStore.getState().error).toBe("boom");
  });

  it("addServer() POSTs config+secrets and appends to the sorted list", async () => {
    const fake = new FakeFetch();
    fake.on("POST", "/api/mcp-servers", () => ({ server: sentryConfig }));
    fake.install();

    // Seed with one server so we can verify sort.
    useMcpStore.setState({ servers: [stdioConfig] });

    await useMcpStore
      .getState()
      .addServer(sentryConfig, { mcp__sentry__SENTRY_TOKEN: "sntrys_abc" });

    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual([
      "linear",
      "sentry",
    ]);
    // The POST body carries both config and secrets.
    expect(fake.calls[0].body).toEqual({
      config: sentryConfig,
      secrets: { mcp__sentry__SENTRY_TOKEN: "sntrys_abc" },
    });
  });

  it("addServer() surfaces a 4xx error and rethrows", async () => {
    const fake = new FakeFetch();
    fake.on("POST", "/api/mcp-servers", () => ({
      status: 409,
      body: { error: "already exists" },
    }));
    fake.install();

    await expect(useMcpStore.getState().addServer(stdioConfig)).rejects.toThrow(
      /already exists/,
    );
    expect(useMcpStore.getState().error).toBe("already exists");
    expect(useMcpStore.getState().servers).toEqual([]);
  });

  it("updateServer() replaces the matching server and keeps the list sorted", async () => {
    const fake = new FakeFetch();
    const renamed: McpServerConfig = {
      ...stdioConfig,
      name: "linearprod",
      env: { LINEAR_API_KEY: "$secret:mcp__linearprod__LINEAR_API_KEY" },
    };
    fake.on("PUT", "/api/mcp-servers/linear", () => ({ server: renamed }));
    fake.install();

    useMcpStore.setState({ servers: [stdioConfig, sentryConfig] });

    await useMcpStore.getState().updateServer("linear", renamed);

    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual([
      "linearprod",
      "sentry",
    ]);
  });

  it("removeServer() drops the server and clears its status entry", async () => {
    const fake = new FakeFetch();
    fake.on("DELETE", "/api/mcp-servers/linear", () => ({ deleted: true }));
    fake.install();

    useMcpStore.setState({
      servers: [stdioConfig, sentryConfig],
      statuses: {
        linear: { state: "loaded" },
        sentry: { state: "loaded" },
      },
    });

    await useMcpStore.getState().removeServer("linear");
    expect(useMcpStore.getState().servers.map((s) => s.name)).toEqual(["sentry"]);
    expect(useMcpStore.getState().statuses).toEqual({ sentry: { state: "loaded" } });
  });

  it("testServer() returns the JSON-RPC test result verbatim", async () => {
    const result: McpTestResult = { ok: true, tools: [{ name: "linear_create_issue" }] };
    const fake = new FakeFetch();
    fake.on("POST", "/api/mcp-servers/linear/test", () => result);
    fake.install();

    const out = await useMcpStore.getState().testServer("linear");
    expect(out).toEqual(result);
  });

  it("testServer() updates statuses so a successful test clears a stale failure badge", async () => {
    // Simulate the bug: a prior agent init left a `failed — connection failed`
    // status on the server. The user fixes the config, hits Test, it succeeds
    // — the badge should now reflect `loaded`, not the old failure.
    useMcpStore.setState({
      statuses: { linear: { state: "failed", reason: "connection failed" } },
    });

    const result: McpTestResult = { ok: true, tools: [{ name: "linear_create_issue" }] };
    const fake = new FakeFetch();
    fake.on("POST", "/api/mcp-servers/linear/test", () => result);
    fake.install();

    await useMcpStore.getState().testServer("linear");
    expect(useMcpStore.getState().statuses.linear).toEqual({
      state: "loaded",
      reason: undefined,
    });
  });

  it("testServer() records a failed test as a `failed` status with the error reason", async () => {
    const result: McpTestResult = { ok: false, error: "401 unauthorized" };
    const fake = new FakeFetch();
    fake.on("POST", "/api/mcp-servers/linear/test", () => result);
    fake.install();

    await useMcpStore.getState().testServer("linear");
    expect(useMcpStore.getState().statuses.linear).toEqual({
      state: "failed",
      reason: "401 unauthorized",
    });
  });

  it("applyStatus() merges a single server's status without disturbing others", () => {
    useMcpStore.getState().applyStatus("linear", "loaded");
    useMcpStore.getState().applyStatus("sentry", "failed", "missing secret: TOKEN");

    expect(useMcpStore.getState().statuses).toEqual({
      linear: { state: "loaded", reason: undefined },
      sentry: { state: "failed", reason: "missing secret: TOKEN" },
    });

    // Overwriting one leaves the other intact.
    useMcpStore.getState().applyStatus("linear", "failed", "install failed");
    expect(useMcpStore.getState().statuses.linear).toEqual({
      state: "failed",
      reason: "install failed",
    });
    expect(useMcpStore.getState().statuses.sentry?.state).toBe("failed");
  });

  it("reset() clears all state", () => {
    useMcpStore.setState({
      servers: [stdioConfig],
      statuses: { linear: { state: "loaded" } },
      loading: true,
      error: "x",
    });
    useMcpStore.getState().reset();
    expect(useMcpStore.getState()).toMatchObject({
      servers: [],
      statuses: {},
      loading: false,
      error: null,
      oauthProviders: [],
      oauthError: null,
    });
  });

  // ---- Phase 2: OAuth ----

  describe("OAuth (docs/088 Phase 2)", () => {
    it("fetchOAuthProviders() populates the provider list", async () => {
      const fake = new FakeFetch();
      fake.on("GET", "/api/mcp-servers/oauth/providers", () => ({
        providers: [
          {
            id: "linear_oauth",
            label: "Linear",
            mcpUrl: "https://mcp.linear.app/mcp",
            defaultServerName: "linear",
            status: { source: "linear_oauth", connected: false },
          },
        ],
      }));
      fake.install();

      await useMcpStore.getState().fetchOAuthProviders();
      const { oauthProviders, oauthLoading, oauthError } = useMcpStore.getState();
      expect(oauthLoading).toBe(false);
      expect(oauthError).toBeNull();
      expect(oauthProviders).toHaveLength(1);
      expect(oauthProviders[0].id).toBe("linear_oauth");
    });

    it("fetchOAuthProviders() defends against missing providers field", async () => {
      const fake = new FakeFetch();
      fake.on("GET", "/api/mcp-servers/oauth/providers", () => ({ wat: 1 }));
      fake.install();

      await useMcpStore.getState().fetchOAuthProviders();
      expect(useMcpStore.getState().oauthProviders).toEqual([]);
    });

    it("fetchOAuthProviders() surfaces backend errors as oauthError", async () => {
      const fake = new FakeFetch();
      fake.on("GET", "/api/mcp-servers/oauth/providers", () => ({
        status: 500,
        body: { error: "boom" },
      }));
      fake.install();

      await useMcpStore.getState().fetchOAuthProviders();
      expect(useMcpStore.getState().oauthError).toBe("boom");
      expect(useMcpStore.getState().oauthProviders).toEqual([]);
    });

    it("disconnectOAuth() round-trips a DELETE and refreshes the provider list", async () => {
      const fake = new FakeFetch();
      fake.on("DELETE", "/api/mcp-servers/oauth/linear_oauth", () => ({ deleted: true }));
      fake.on("GET", "/api/mcp-servers/oauth/providers", () => ({
        providers: [
          {
            id: "linear_oauth",
            label: "Linear",
            mcpUrl: "https://mcp.linear.app/mcp",
            defaultServerName: "linear",
            status: { source: "linear_oauth", connected: false },
          },
        ],
      }));
      fake.install();

      await useMcpStore.getState().disconnectOAuth("linear_oauth");
      // The fetch fake recorded both the DELETE and the follow-up GET.
      const methods = fake.calls.map((c) => c.method);
      expect(methods).toContain("DELETE");
      expect(methods).toContain("GET");
      // Final state shows the (refreshed) disconnected provider.
      expect(useMcpStore.getState().oauthProviders[0].status.connected).toBe(false);
    });
  });
});
