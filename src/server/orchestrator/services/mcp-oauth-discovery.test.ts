/**
 * Unit tests for MCP OAuth metadata discovery (docs/139).
 *
 * Covers the discovery chain (WWW-Authenticate → protected-resource →
 * authorization-server), RFC 8414 path construction, the openid-configuration
 * fallback, the S256 requirement, the in-memory cache, and the SSRF
 * origin-validation guards.
 *
 * The `fetch` boundary is faked — none of these touch the network.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  discoverOAuthMetadata,
  parseResourceMetadata,
  buildWellKnown,
  _clearDiscoveryCache,
} from "./mcp-oauth-discovery.js";
import { ServiceError } from "./types.js";

const NOTION_MCP = "https://mcp.notion.com/mcp";

/** Default canned responses for the Notion discovery chain. */
function notionFetch(opts?: {
  /** Drop the WWW-Authenticate header so the well-known fallback runs. */
  noChallenge?: boolean;
  /** AS metadata overrides. */
  asMeta?: Record<string, unknown>;
  /** authorization_servers override in the protected-resource metadata. */
  authServers?: string[];
  /** Make the RFC 8414 path 404 so the openid-configuration fallback runs. */
  rfc8414Status?: number;
}): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const asMeta = opts?.asMeta ?? {
    issuer: "https://mcp.notion.com",
    authorization_endpoint: "https://mcp.notion.com/authorize",
    token_endpoint: "https://mcp.notion.com/token",
    registration_endpoint: "https://mcp.notion.com/register",
    code_challenge_methods_supported: ["plain", "S256"],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url === NOTION_MCP && init?.method === "POST") {
      if (opts?.noChallenge) return new Response("ok", { status: 200 });
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
        },
      });
    }
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
      return new Response(
        JSON.stringify({
          resource: "https://mcp.notion.com",
          authorization_servers: opts?.authServers ?? ["https://mcp.notion.com"],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/.well-known/oauth-protected-resource")) {
      return new Response(
        JSON.stringify({
          resource: "https://mcp.notion.com",
          authorization_servers: opts?.authServers ?? ["https://mcp.notion.com"],
        }),
        { status: 200 },
      );
    }
    if (url === "https://mcp.notion.com/.well-known/oauth-authorization-server") {
      if (opts?.rfc8414Status && opts.rfc8414Status !== 200) {
        return new Response("not found", { status: opts.rfc8414Status });
      }
      return new Response(JSON.stringify(asMeta), { status: 200 });
    }
    if (url === "https://mcp.notion.com/.well-known/openid-configuration") {
      return new Response(JSON.stringify(asMeta), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, urls };
}

describe("services/mcp-oauth-discovery (docs/139)", () => {
  beforeEach(() => _clearDiscoveryCache());

  describe("parseResourceMetadata", () => {
    it("extracts the quoted resource_metadata value", () => {
      expect(
        parseResourceMetadata(
          'Bearer realm="OAuth", resource_metadata="https://x/.well-known/y", error="invalid_token"',
        ),
      ).toBe("https://x/.well-known/y");
    });

    it("returns undefined when absent", () => {
      expect(parseResourceMetadata('Bearer realm="OAuth"')).toBeUndefined();
    });
  });

  describe("buildWellKnown (RFC 8414 path construction)", () => {
    it("appends the segment for an origin-rooted issuer", () => {
      expect(buildWellKnown("https://mcp.notion.com", "oauth-authorization-server")).toBe(
        "https://mcp.notion.com/.well-known/oauth-authorization-server",
      );
    });

    it("ignores a trailing slash", () => {
      expect(buildWellKnown("https://host/", "oauth-authorization-server")).toBe(
        "https://host/.well-known/oauth-authorization-server",
      );
    });

    it("inserts the segment between host and path for an issuer with a path", () => {
      expect(buildWellKnown("https://host/tenant1", "oauth-authorization-server")).toBe(
        "https://host/.well-known/oauth-authorization-server/tenant1",
      );
    });
  });

  describe("discoverOAuthMetadata — happy path", () => {
    it("follows WWW-Authenticate → protected-resource → AS metadata", async () => {
      const { fetchImpl, urls } = notionFetch();
      const meta = await discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl });
      expect(meta.authorizationEndpoint).toBe("https://mcp.notion.com/authorize");
      expect(meta.tokenEndpoint).toBe("https://mcp.notion.com/token");
      expect(meta.registrationEndpoint).toBe("https://mcp.notion.com/register");
      expect(meta.codeChallengeMethods).toContain("S256");
      // Used the header-advertised metadata URL (not a guessed well-known).
      expect(urls).toContain("https://mcp.notion.com/.well-known/oauth-protected-resource/mcp");
    });

    it("falls back to well-known paths when there is no WWW-Authenticate challenge", async () => {
      const { fetchImpl, urls } = notionFetch({ noChallenge: true });
      const meta = await discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl });
      expect(meta.tokenEndpoint).toBe("https://mcp.notion.com/token");
      // Tried the resource-suffixed well-known path.
      expect(
        urls.some((u) => u.endsWith("/.well-known/oauth-protected-resource/mcp")),
      ).toBe(true);
    });

    it("falls back to openid-configuration when the RFC 8414 path 404s", async () => {
      const { fetchImpl, urls } = notionFetch({ rfc8414Status: 404 });
      const meta = await discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl });
      expect(meta.tokenEndpoint).toBe("https://mcp.notion.com/token");
      expect(urls).toContain("https://mcp.notion.com/.well-known/openid-configuration");
    });

    it("caches the result (second call makes no fetches)", async () => {
      const { fetchImpl, urls } = notionFetch();
      await discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl });
      const countAfterFirst = urls.length;
      await discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl });
      expect(urls.length).toBe(countAfterFirst);
    });
  });

  describe("discoverOAuthMetadata — failures", () => {
    it("throws 502 when S256 is not supported", async () => {
      const { fetchImpl } = notionFetch({
        asMeta: {
          authorization_endpoint: "https://mcp.notion.com/authorize",
          token_endpoint: "https://mcp.notion.com/token",
          code_challenge_methods_supported: ["plain"],
        },
      });
      await expect(
        discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("throws 502 when no metadata is discoverable", async () => {
      const fetchImpl: typeof fetch = async () => new Response("nope", { status: 404 });
      await expect(
        discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl }),
      ).rejects.toBeInstanceOf(ServiceError);
    });
  });

  describe("discoverOAuthMetadata — SSRF origin guards", () => {
    it("rejects a resource_metadata URL pointing off-origin", async () => {
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url === NOTION_MCP && init?.method === "POST") {
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Bearer resource_metadata="https://evil.example.com/.well-known/oauth-protected-resource"',
            },
          });
        }
        return new Response("{}", { status: 200 });
      };
      await expect(
        discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("rejects an authorization server off the resource origin", async () => {
      const { fetchImpl } = notionFetch({ authServers: ["https://evil.example.com"] });
      await expect(
        discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("rejects a token_endpoint off the AS origin", async () => {
      const { fetchImpl } = notionFetch({
        asMeta: {
          authorization_endpoint: "https://mcp.notion.com/authorize",
          token_endpoint: "https://evil.example.com/token",
          registration_endpoint: "https://mcp.notion.com/register",
          code_challenge_methods_supported: ["S256"],
        },
      });
      await expect(
        discoverOAuthMetadata({ mcpUrl: NOTION_MCP, fetchImpl }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });
  });
});
