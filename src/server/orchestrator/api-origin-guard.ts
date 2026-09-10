// Browser-origin protection, not authentication. Deployment access controls and
// api-container-guard.ts cover callers that can omit or forge browser headers.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { parsePreviewSubdomain } from "./preview-proxy.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** The route must validate cross-site navigations itself, e.g. OAuth state. */
    crossOriginNavigation?: boolean;
  }
}

export interface ConfiguredOrigin {
  host: string;
  /** null permits either HTTP scheme. */
  protocol: string | null;
}

export interface OriginPolicy {
  extraOrigins: ConfiguredOrigin[];
  devClientPort: string | null;
}

export function readOriginPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const extraOrigins: ConfiguredOrigin[] = [];
  for (const raw of (env.SHIPIT_ALLOWED_ORIGINS ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const parsed = parseOrigin(entry);
    extraOrigins.push(
      parsed
        ? { host: parsed.host, protocol: parsed.protocol }
        : { host: entry.toLowerCase(), protocol: null },
    );
  }
  const devPort = (env.CLIENT_DEV_PORT ?? "").trim();
  return {
    extraOrigins,
    devClientPort: /^\d+$/.test(devPort) ? devPort : null,
  };
}

export function parseOrigin(origin: string): { host: string; protocol: string } | null {
  if (!origin || origin === "null") return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.host) return null;
    return { host: url.host.toLowerCase(), protocol: url.protocol };
  } catch {
    return null;
  }
}

export function parseOriginHost(origin: string): string | null {
  return parseOrigin(origin)?.host ?? null;
}

// Enforce scheme only with a TLS signal; some terminating proxies omit that header.
function requestIsSecure(request: FastifyRequest): boolean {
  const forwarded = headerValue(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim();
  if (forwarded) return forwarded.toLowerCase() === "https";
  return (request.socket as { encrypted?: boolean }).encrypted === true;
}

function splitHostPort(hostHeader: string): { hostname: string; port: string | null } {
  const host = hostHeader.toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return { hostname: host, port: null };
    const rest = host.slice(end + 1);
    return { hostname: host.slice(0, end + 1), port: rest.startsWith(":") ? rest.slice(1) : null };
  }
  const colon = host.lastIndexOf(":");
  if (colon === -1) return { hostname: host, port: null };
  return { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

// The preview proxy puts the browser-facing host in X-Forwarded-Host.
// Cross-origin scripts cannot set it without a preflight; same-origin scripts can.
export function selfHostsFrom(headers: IncomingHttpHeaders): string[] {
  const out: string[] = [];
  const forwarded = headerValue(headers["x-forwarded-host"]);
  // A chained proxy appends; the left-most entry is the browser's.
  const first = forwarded?.split(",")[0]?.trim();
  if (first) out.push(first.toLowerCase());
  if (typeof headers.host === "string" && headers.host) out.push(headers.host.toLowerCase());
  return out;
}

export function isAllowedOrigin(
  origin: string,
  selfHosts: string[],
  policy: OriginPolicy,
  opts: { requestIsSecure?: boolean } = {},
): boolean {
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  const { host: originHost, protocol } = parsed;

  if (opts.requestIsSecure && protocol === "http:") return false;

  if (selfHosts.includes(originHost)) return true;

  if (policy.extraOrigins.some(
    (e) => e.host === originHost && (e.protocol === null || e.protocol === protocol),
  )) return true;

  if (policy.devClientPort) {
    const wanted = splitHostPort(originHost);
    if (wanted.port === policy.devClientPort
      && selfHosts.some((self) => sameDevHostname(splitHostPort(self).hostname, wanted.hostname))) {
      return true;
    }
  }

  return false;
}

// Local names depend on trust in the local resolver.
const UNREGISTRABLE_SUFFIXES = [
  ".localhost",
  ".ts.net",
  ".internal",
  ".home.arpa",
];

// Exclude .local: any LAN host can answer mDNS and rebind it.
// These wildcard services are trusted to resolve the address encoded in the name.
const SELF_DESCRIBING_DNS_SUFFIXES = ["sslip.io", "nip.io"];

const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const DASHED_IPV4 = new RegExp(`^${OCTET}-${OCTET}-${OCTET}-${OCTET}$`);
const BARE_OCTET = new RegExp(`^${OCTET}$`);

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return IPV4.test(hostname);
}

function encodesItsOwnAddress(hostname: string): boolean {
  for (const suffix of SELF_DESCRIBING_DNS_SUFFIXES) {
    if (!hostname.endsWith(`.${suffix}`)) continue;
    const labels = hostname.slice(0, -(suffix.length + 1)).split(".");
    const last = labels[labels.length - 1] ?? "";
    if (DASHED_IPV4.test(last)) return true;
    if (labels.length >= 4 && labels.slice(-4).every((l) => BARE_OCTET.test(l))) return true;
  }
  return false;
}

// DNS rebinding preserves same-origin. Check Host on all guarded requests, even
// without Origin/Fetch Metadata. Scripts can forge forwarded headers, but not Host.
// Preview-proxied inner instances remain outside this protection (SECURITY-MODEL.md).
export function isTrustedRequestHost(
  hostHeader: string | undefined,
  policy: OriginPolicy,
): boolean {
  if (!hostHeader) return true;
  const { hostname: raw } = splitHostPort(hostHeader);
  const hostname = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (!hostname) return true;
  if (isIpLiteral(hostname)) return true;
  if (!hostname.includes(".")) return true;
  if (UNREGISTRABLE_SUFFIXES.some((s) => hostname.endsWith(s))) return true;
  if (encodesItsOwnAddress(hostname)) return true;
  return policy.extraOrigins.some((e) => splitHostPort(e.host).hostname === hostname);
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function sameDevHostname(a: string, b: string): boolean {
  if (a === b) return true;
  return LOOPBACK_NAMES.has(a) && LOOPBACK_NAMES.has(b);
}

// Browsers can omit Fetch Metadata. Missing headers do not establish trust.
// Refuse same-site too: preview subdomains are not trusted API origins.
export function isAllowedWithoutOrigin(secFetchSite: string | undefined): boolean {
  if (!secFetchSite) return true;
  return secFetchSite === "same-origin" || secFetchSite === "none";
}

export function isAllowedCrossSiteNavigation(
  method: string,
  headers: IncomingHttpHeaders,
  routeConfig: { crossOriginNavigation?: boolean } | undefined,
): boolean {
  if (routeConfig?.crossOriginNavigation !== true) return false;
  if (method !== "GET") return false;
  return headerValue(headers["sec-fetch-mode"]) === "navigate"
    && headerValue(headers["sec-fetch-dest"]) === "document";
}

export function isOriginGuardedPath(pathname: string): boolean {
  return (
    pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/ws"
    || pathname.startsWith("/ws/")
  );
}

// The router decodes paths such as /%61pi/bootstrap; guard their decoded form too.
export function isGuardedRequest(rawUrl: string | undefined, routeUrl: string | undefined): boolean {
  const path = (rawUrl ?? "/").split("?")[0] ?? "/";
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed percent-encoding — judge the raw form.
  }
  return isOriginGuardedPath(path)
    || isOriginGuardedPath(decoded)
    || (routeUrl !== undefined && isOriginGuardedPath(routeUrl));
}

// SSE writes raw headers, so it must apply this policy outside the reply hook.
export function corsHeadersFor(
  origin: string | undefined,
  headers: IncomingHttpHeaders,
  policy: OriginPolicy,
  opts: { requestIsSecure?: boolean } = {},
): Record<string, string> {
  if (!origin || !isTrustedRequestHost(headers.host, policy)) return {};
  if (!isAllowedOrigin(origin, selfHostsFrom(headers), policy, opts)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

// WebSockets bypass CORS; validate the handshake's Origin explicitly.
export function isWebSocketOriginAllowed(
  headers: IncomingHttpHeaders,
  policy: OriginPolicy,
  opts: { requestIsSecure?: boolean } = {},
): boolean {
  const origin = headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  if (!isTrustedRequestHost(headers.host, policy)) return false;
  return isAllowedOrigin(origin, selfHostsFrom(headers), policy, opts);
}

// Scope the preview bypass to each app, not every app in the process.
const appsWithPreviewProxy = new WeakSet<FastifyInstance>();

export function markPreviewProxyRegistered(app: FastifyInstance): void {
  appsWithPreviewProxy.add(app);
}

export function hasPreviewProxy(app: FastifyInstance): boolean {
  return appsWithPreviewProxy.has(app);
}

// Register first, before the container guard and preview proxy.
export function registerOriginGuard(
  app: FastifyInstance,
  policy: OriginPolicy = readOriginPolicyFromEnv(),
): void {
  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const host = request.headers.host;

    if (appsWithPreviewProxy.has(app) && parsePreviewSubdomain(host)) {
      done();
      return;
    }

    const origin = request.headers.origin;
    const secure = { requestIsSecure: requestIsSecure(request) };
    for (const [name, value] of Object.entries(
      corsHeadersFor(origin, request.headers, policy, secure),
    )) {
      reply.header(name, value);
    }
    // Vary even on refusal so caches cannot reuse another origin's response.
    if (origin) reply.header("Vary", "Origin");

    if (isGuardedRequest(request.url, request.routeOptions?.url)) {
      if (!isTrustedRequestHost(host, policy)) {
        warnUntrustedHost(host);
        void reply.code(403).send({
          error: "Request host is not a hostname ShipIt answers to.",
          host: host ?? null,
          hint: "If this is your own domain, add it to SHIPIT_ALLOWED_ORIGINS "
            + "(see SECURITY-MODEL.md, 'Network exposure and access control').",
        });
        return;
      }
      const allowed = origin
        ? isAllowedOrigin(origin, selfHostsFrom(request.headers), policy, secure)
        : isAllowedWithoutOrigin(headerValue(request.headers["sec-fetch-site"]))
          || isAllowedCrossSiteNavigation(
            request.method,
            request.headers,
            request.routeOptions?.config,
          );
      if (!allowed) {
        void reply
          .code(403)
          .send({ error: "Cross-origin request refused." });
        return;
      }
    }

    if (request.method === "OPTIONS") {
      void reply.status(204).send();
      return;
    }
    done();
  });
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

const warnedHosts = new Set<string>();

function warnUntrustedHost(host: string | undefined): void {
  const key = host ?? "(no Host header)";
  if (warnedHosts.has(key) || warnedHosts.size >= 100) return;
  warnedHosts.add(key);
  console.warn(
    `[origin-guard] refused an API request whose Host is "${key}" — not a hostname `
    + "ShipIt can prove is its own (planning#378, DNS-rebinding protection). If this is "
    + "your own domain in front of ShipIt, set SHIPIT_ALLOWED_ORIGINS to include it.",
  );
}
