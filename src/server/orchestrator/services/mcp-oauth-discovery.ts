/**
 * MCP OAuth metadata discovery (docs/139-mcp-dynamic-client-registration).
 *
 * Implements the MCP authorization discovery chain so the OAuth flow can be
 * driven from the provider's *own* authorization server rather than hardcoded
 * registry endpoints:
 *
 *   1. Probe `mcpUrl` unauthenticated → read `resource_metadata` from the 401
 *      `WWW-Authenticate` header (authoritative). Fall back to the well-known
 *      paths only if the challenge is absent.
 *   2. Fetch the protected-resource metadata → `authorization_servers[0]`.
 *   3. Fetch the authorization-server metadata (RFC 8414) → authorize / token /
 *      registration endpoints + supported PKCE methods.
 *
 * **Security (SSRF):** discovery follows URLs derived from the provider's own
 * responses, so every hop is origin-validated before the fetch — the
 * `resource_metadata` URL must share `mcpUrl`'s origin, the AS must share the
 * `resource` origin, and each discovered endpoint must share the AS origin.
 * `mcpUrl` is registry/operator-controlled today; if it ever becomes
 * user-supplied, add an allowlist before relaxing these checks.
 */

import { getErrorMessage } from "../../shared/utils.js";
import { ServiceError } from "./types.js";

/** Normalized result of a successful discovery run. */
export interface DiscoveredOAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** PKCE code challenge methods the AS advertises. */
  codeChallengeMethods: string[];
}

interface CacheEntry {
  value: DiscoveredOAuthMetadata;
  expiresAt: number;
}

/** Endpoints are stable; a short TTL avoids re-probing on every connect. */
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, CacheEntry>();

/** Exposed for tests — clears the in-memory discovery cache. */
export function _clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Discover the OAuth endpoints for a hosted MCP server starting from its
 * `mcpUrl`. Results are cached in-memory with a short TTL.
 *
 * Throws `ServiceError(502)` on any discovery failure (unreachable metadata,
 * origin mismatch, missing S256 support) — these surface as inline errors in
 * the Settings panel before the popup opens.
 */
export async function discoverOAuthMetadata(opts: {
  mcpUrl: string;
  fetchImpl?: typeof fetch;
  /** Override for tests — defaults to `Date.now`. */
  now?: () => number;
}): Promise<DiscoveredOAuthMetadata> {
  const now = (opts.now ?? Date.now)();
  const cached = discoveryCache.get(opts.mcpUrl);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const f = opts.fetchImpl ?? fetch;
  const mcpOrigin = originOf(opts.mcpUrl);
  if (!mcpOrigin) {
    throw new ServiceError(502, `Invalid MCP URL: ${opts.mcpUrl}`);
  }

  // 1. Find the protected-resource metadata URL (header first).
  const resourceMetadataUrl = await findResourceMetadataUrl(opts.mcpUrl, mcpOrigin, f);

  // 2. Protected-resource metadata → authorization_servers[0].
  const prMeta = await fetchJson(f, resourceMetadataUrl, "protected-resource metadata");
  const resource = stringField(prMeta, "resource") ?? opts.mcpUrl;
  const resourceOrigin = originOf(resource) ?? mcpOrigin;
  const authServers = arrayField(prMeta, "authorization_servers");
  const asUrl = authServers.find((s): s is string => typeof s === "string");
  if (!asUrl) {
    throw new ServiceError(
      502,
      "Protected-resource metadata did not advertise an authorization server",
    );
  }
  requireSameOrigin(asUrl, resourceOrigin, "authorization server");

  // 3. Authorization-server metadata (RFC 8414, openid-configuration fallback).
  const asMeta = await fetchAuthServerMetadata(f, asUrl);
  // `asUrl` was just origin-validated, so `originOf` is guaranteed non-null.
  const asOrigin = originOf(asUrl) ?? "";

  const authorizationEndpoint = stringField(asMeta, "authorization_endpoint");
  const tokenEndpoint = stringField(asMeta, "token_endpoint");
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new ServiceError(
      502,
      "Authorization-server metadata missing authorization_endpoint or token_endpoint",
    );
  }
  requireSameOrigin(authorizationEndpoint, asOrigin, "authorization_endpoint");
  requireSameOrigin(tokenEndpoint, asOrigin, "token_endpoint");

  const registrationEndpoint = stringField(asMeta, "registration_endpoint");
  if (registrationEndpoint) {
    requireSameOrigin(registrationEndpoint, asOrigin, "registration_endpoint");
  }

  const codeChallengeMethods = arrayField(asMeta, "code_challenge_methods_supported").filter(
    (m): m is string => typeof m === "string",
  );
  // We always send S256; refuse rather than start a flow that will fail.
  if (codeChallengeMethods.length > 0 && !codeChallengeMethods.includes("S256")) {
    throw new ServiceError(
      502,
      "Authorization server doesn't support S256 PKCE (required by ShipIt)",
    );
  }

  const value: DiscoveredOAuthMetadata = {
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    codeChallengeMethods,
  };
  discoveryCache.set(opts.mcpUrl, { value, expiresAt: now + DISCOVERY_TTL_MS });
  return value;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Resolve the protected-resource metadata URL. The MCP auth spec says the
 * authoritative source is the `resource_metadata` value in the `401`
 * `WWW-Authenticate` header; we fall back to the well-known guesses only if
 * the challenge is absent.
 */
async function findResourceMetadataUrl(
  mcpUrl: string,
  mcpOrigin: string,
  f: typeof fetch,
): Promise<string> {
  const headerUrl = await probeWwwAuthenticate(mcpUrl, f);
  if (headerUrl) {
    requireSameOrigin(headerUrl, mcpOrigin, "resource_metadata");
    return headerUrl;
  }

  // Fall back to the well-known paths (both the bare and resource-suffixed
  // forms — the suffixed form is what Notion publishes).
  const origin = mcpOrigin;
  const suffix = pathSuffix(mcpUrl);
  const candidates = [
    `${origin}/.well-known/oauth-protected-resource${suffix}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ];
  for (const url of candidates) {
    if (await urlResolves(f, url)) return url;
  }
  throw new ServiceError(
    502,
    "Couldn't discover OAuth configuration: no WWW-Authenticate challenge and no protected-resource metadata at the well-known paths",
  );
}

/**
 * Unauthenticated probe of `mcpUrl`. Returns the `resource_metadata` URL from
 * the `WWW-Authenticate` header of a 401, or `undefined` if absent.
 */
async function probeWwwAuthenticate(
  mcpUrl: string,
  f: typeof fetch,
): Promise<string | undefined> {
  let res: Response;
  try {
    res = await f(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 0 }),
    });
  } catch {
    // Network error probing the endpoint — let the well-known fallback try.
    return undefined;
  }
  const header = res.headers.get("www-authenticate");
  if (!header) return undefined;
  return parseResourceMetadata(header);
}

/**
 * Fetch authorization-server metadata per RFC 8414. For an origin-rooted
 * issuer the well-known segment is appended; for an issuer *with a path* the
 * segment is inserted between host and path. Falls back to
 * `openid-configuration` on 404.
 */
async function fetchAuthServerMetadata(
  f: typeof fetch,
  issuer: string,
): Promise<Record<string, unknown>> {
  const candidates = [
    buildWellKnown(issuer, "oauth-authorization-server"),
    buildWellKnown(issuer, "openid-configuration"),
  ];
  let lastError = "";
  for (const url of candidates) {
    try {
      const res = await f(url, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const parsed: unknown = await res.json().catch(() => null);
        if (parsed && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
        lastError = `${url} returned a non-object body`;
        continue;
      }
      lastError = `${url} returned ${res.status}`;
    } catch (err) {
      lastError = `${url}: ${getErrorMessage(err)}`;
    }
  }
  throw new ServiceError(
    502,
    `Couldn't discover OAuth configuration: ${lastError || "authorization-server metadata unreachable"}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the `resource_metadata` parameter out of a `WWW-Authenticate` header.
 * Example header:
 *   Bearer realm="OAuth", resource_metadata="https://x/.well-known/...", error="invalid_token"
 */
export function parseResourceMetadata(header: string): string | undefined {
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  if (m) return m[1];
  // Tolerate an unquoted form.
  const m2 = /resource_metadata\s*=\s*([^\s,]+)/i.exec(header);
  return m2 ? m2[1] : undefined;
}

/**
 * RFC 8414 well-known URL construction. For an origin-rooted issuer
 * (`https://host` or `https://host/`) the segment is appended:
 *   `https://host/.well-known/<segment>`
 * For an issuer with a path component the segment is inserted between host
 * and path:
 *   `https://host/.well-known/<segment>/<path>`
 */
export function buildWellKnown(issuer: string, segment: string): string {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  if (path === "" || path === "/") {
    return `${u.origin}/.well-known/${segment}`;
  }
  return `${u.origin}/.well-known/${segment}${path}`;
}

/** Return the path (with any trailing slash trimmed) of a URL, or "". */
function pathSuffix(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return path === "/" ? "" : path;
  } catch {
    return "";
  }
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/**
 * Throw `ServiceError(502)` unless `url` is HTTPS and shares `expectedOrigin`.
 * The SSRF guard: discovery must never follow a derived URL off-origin.
 */
function requireSameOrigin(url: string, expectedOrigin: string, label: string): void {
  const origin = originOf(url);
  if (!origin) {
    throw new ServiceError(502, `Discovered ${label} URL is not a valid HTTPS URL`);
  }
  if (origin !== expectedOrigin) {
    throw new ServiceError(
      502,
      `Discovered ${label} origin (${origin}) does not match expected origin (${expectedOrigin})`,
    );
  }
}

async function fetchJson(
  f: typeof fetch,
  url: string,
  label: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new ServiceError(502, `Couldn't fetch ${label}: ${getErrorMessage(err)}`);
  }
  if (!res.ok) {
    throw new ServiceError(502, `Couldn't fetch ${label}: ${url} returned ${res.status}`);
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (!parsed || typeof parsed !== "object") {
    throw new ServiceError(502, `${label} returned a non-object body`);
  }
  return parsed as Record<string, unknown>;
}

async function urlResolves(f: typeof fetch, url: string): Promise<boolean> {
  try {
    const res = await f(url, { headers: { Accept: "application/json" } });
    return res.ok;
  } catch {
    return false;
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function arrayField(obj: Record<string, unknown>, key: string): unknown[] {
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}
