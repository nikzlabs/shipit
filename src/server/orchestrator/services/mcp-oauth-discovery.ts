import { getErrorMessage } from "../../shared/utils.js";
import { ServiceError } from "./types.js";

export interface DiscoveredOAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  codeChallengeMethods: string[];
}

interface CacheEntry {
  value: DiscoveredOAuthMetadata;
  expiresAt: number;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, CacheEntry>();

export function _clearDiscoveryCache(): void {
  discoveryCache.clear();
}

export async function discoverOAuthMetadata(opts: {
  mcpUrl: string;
  fetchImpl?: typeof fetch;
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

  const resourceMetadataUrl = await findResourceMetadataUrl(opts.mcpUrl, mcpOrigin, f);

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

  const asMeta = await fetchAuthServerMetadata(f, asUrl);
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
  // The OAuth flow always sends S256.
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

// An advertised resource_metadata URL takes precedence over well-known paths.
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
    return undefined;
  }
  const header = res.headers.get("www-authenticate");
  if (!header) return undefined;
  return parseResourceMetadata(header);
}

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

export function parseResourceMetadata(header: string): string | undefined {
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  if (m) return m[1];
  const m2 = /resource_metadata\s*=\s*([^\s,]+)/i.exec(header);
  return m2 ? m2[1] : undefined;
}

// RFC 8414 places the well-known segment before the issuer's path.
export function buildWellKnown(issuer: string, segment: string): string {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  if (path === "" || path === "/") {
    return `${u.origin}/.well-known/${segment}`;
  }
  return `${u.origin}/.well-known/${segment}${path}`;
}

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
