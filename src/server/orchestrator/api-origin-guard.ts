/**
 * planning#370 — browser-origin trust boundary on the orchestrator API.
 *
 * The counterpart to `api-container-guard.ts`, for the other direction. That
 * guard classifies a caller by TCP source IP, which answers "is this code
 * running inside a session container?" and nothing else. Code running in the
 * *user's browser* has, by construction, a trusted source IP — so a page the
 * user happens to load could call `/api/*` with the user's cookies/session and,
 * because the old CORS hook reflected **any** `Origin` back with
 * `Access-Control-Allow-Credentials: true`, **read the responses**.
 *
 * Two ordinary shapes made that reachable:
 *   - a page served into the preview at `{sessionId}--{port}.<host>` — agent-
 *     authored, possibly plugin-authored code — deriving the main origin from
 *     its own;
 *   - any unrelated site the user visits, for a loopback- or tailnet-reachable
 *     instance (docs/254).
 *
 * ## The policy
 *
 * **Same-origin only.** No cross-origin caller is granted read access, and the
 * two apparent exceptions are not exceptions:
 *
 *   1. **The dev client on another port.** `docker/local/dev/compose.yml` runs
 *      Vite on `CLIENT_DEV_PORT` and the orchestrator on `PORT`, and the client
 *      opens the WS + SSE streams straight at the API port (`VITE_API_HOST`),
 *      so those two are genuinely cross-origin. Allowed only when
 *      `CLIENT_DEV_PORT` is set (it is set by the dev image and by nothing
 *      else), and only for the *same hostname* on that one port.
 *   2. **`SHIPIT_ALLOWED_ORIGINS`** — the escape hatch for a deployment whose
 *      reverse proxy rewrites `Host` to an internal name, which would otherwise
 *      make every request look cross-origin. Empty by default.
 *
 * Everything else ShipIt owns is covered without configuration, because "same
 * origin" is computed from the request's own host headers rather than from a
 * configured hostname. That is what keeps docs/254 working: loopback, a tailnet
 * IP, a MagicDNS name and a public domain are all simultaneously correct, with
 * nothing to keep in sync. Those headers are safe to derive trust from here
 * precisely because the attacker in this threat model is a *web page*: it can
 * set neither (see {@link selfHostsFrom}), while `Origin` names the page
 * itself.
 *
 * Scheme is compared **one way only**. Requiring a match outright would mean
 * depending on `x-forwarded-proto`, and a TLS-terminating proxy that fails to
 * set it would make every request look cross-origin and take the product down.
 * So: when we can see that the request arrived over TLS, an `http://` origin on
 * the same host is refused — that page is not the same origin and must not be
 * able to read the HTTPS API (review finding). When there is no TLS signal at
 * all, scheme stays ignored, which is exactly today's behaviour and cannot
 * break a deployment that was working. An origin written WITH a scheme in
 * `SHIPIT_ALLOWED_ORIGINS` is matched on that scheme exactly, because there the
 * operator said what they meant.
 *
 * ## What is guarded
 *
 * Only `/api/*` and `/ws/*`. Static assets and the SPA fallback are untouched,
 * so a cross-site *navigation* into ShipIt still works — it is a link to a page,
 * not a call to an API.
 *
 * **Preview hosts are skipped entirely.** A request whose `Host` is
 * `{uuid}--{port}.…` is hijacked by `preview-proxy.ts` and never reaches an API
 * route; its `/api/…` paths belong to the previewed app, not to ShipIt, and
 * that app may legitimately be navigated to one. The skip is conditional on the
 * proxy actually being registered for this app instance (`markPreviewProxyRegistered`)
 * so that a runtime with no proxy — `RUNTIME_MODE=local`, the dogfood inner
 * instance — cannot be reached by sending a preview-shaped `Host` to bypass the
 * check.
 *
 * ## Requests with no `Origin`
 *
 * A missing `Origin` is NOT hostile. Session containers reach the orchestrator
 * over plain HTTP with no browser headers at all (`shipit issue`, PR operations,
 * the egress-decision sidecar), and same-origin `GET` from the browser also
 * omits it. Those two are told apart by `Sec-Fetch-Site`, which only a browser
 * sends: absent → non-browser → allowed (and `api-container-guard.ts` governs
 * it); `same-origin`/`none` → allowed; `same-site`/`cross-site` → refused.
 *
 * A browser too old to send `Sec-Fetch-Site` (Safari before 16.4) therefore
 * lands in the "non-browser" branch for its no-`Origin` requests. It degrades
 * gracefully rather than opening a hole: every state-changing method carries
 * `Origin` and is still refused, and a cross-origin *read* is still unreadable
 * because the CORS half sends no `Access-Control-Allow-Origin`. What is lost is
 * only the extra refusal on a cross-site sub-resource GET, whose response that
 * page could not have read anyway.
 *
 * `same-site` must be refused rather than allowed, and that is the whole point:
 * the preview host is a *subdomain* of the main host, so a preview page's
 * requests are same-site but not same-origin. A cookie-style `SameSite` control
 * — or a wildcard-subdomain CORS rule — would have trusted exactly the attacker
 * this closes out.
 *
 * The one exception is a route whose normal caller genuinely IS another site
 * redirecting the browser onto it — an OAuth callback. Those opt in with
 * `config: { crossOriginNavigation: true }`, and the exemption applies only to a
 * `GET` top-level document navigation carrying no `Origin`, so a cross-origin
 * `fetch()` at the same path stays refused. Refusing it outright broke MCP OAuth
 * outright and was caught in review; see {@link isAllowedCrossSiteNavigation}.
 *
 * ## What this is NOT
 *
 * **Not authentication.** Anything that is not a browser still reaches the API
 * by simply not sending an `Origin`, exactly as before. ShipIt's access control
 * is still the deployment's access layer (`SECURITY-MODEL.md`, "Network exposure
 * and access control"); this closes the case that layer cannot see, because the
 * request comes from the user's own authenticated browser.
 *
 * **Not a defence against DNS rebinding.** An attacker-controlled name that
 * re-resolves to a loopback / tailnet instance produces a page whose `Origin`
 * and the request's `Host` are both that name, so the same-origin test passes.
 * Closing it needs an allowlist of the hostnames ShipIt answers to, which is in
 * direct tension with docs/254 — the whole point there is that one instance is
 * legitimately reached by loopback, a tailnet IP, a MagicDNS name and a domain
 * at once, with nothing to keep in sync. Left as a known residual rather than
 * half-solved; tracked as planning#378.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { parsePreviewSubdomain } from "./preview-proxy.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * planning#370 — this route is a legitimate **cross-site navigation** target:
     * the browser lands on it because some other site redirected it here, so
     * `Sec-Fetch-Site: cross-site` is the normal, correct case rather than an
     * attack. An OAuth callback is the whole population today.
     *
     * Set it only on a route that is safe to reach that way ON ITS OWN — the
     * MCP callback validates a one-time `state` it issued, so a forged landing
     * is rejected by the route, not by this guard. The exemption is narrow: it
     * applies only to a `GET` **top-level document navigation** that carries no
     * `Origin`, so a cross-origin `fetch()` at the same path is still refused.
     */
    crossOriginNavigation?: boolean;
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface ConfiguredOrigin {
  /** Lowercased `host[:port]`. */
  host: string;
  /**
   * `"http:"` / `"https:"` when the operator wrote a scheme, else `null`.
   * A written scheme is honoured exactly — configuring `https://x` must not
   * quietly also trust `http://x`. A bare `host:port` matches either, since
   * the operator expressed no preference.
   */
  protocol: string | null;
}

export interface OriginPolicy {
  /** Additional origins ShipIt owns. From `SHIPIT_ALLOWED_ORIGINS`. */
  extraOrigins: ConfiguredOrigin[];
  /**
   * The Vite dev-server port, when this process is the dev image's
   * orchestrator. `null` in every production runtime.
   */
  devClientPort: string | null;
}

/** Read the policy from the environment. Production supplies neither variable. */
export function readOriginPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const extraOrigins: ConfiguredOrigin[] = [];
  for (const raw of (env.SHIPIT_ALLOWED_ORIGINS ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    // Accept both `https://host:port` and a bare `host:port`.
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

// ---------------------------------------------------------------------------
// Origin comparison
// ---------------------------------------------------------------------------

/**
 * The `host[:port]` of an `Origin` header value, lowercased — or `null` when it
 * is opaque (`"null"`, the value a sandboxed iframe sends), not a URL, or not
 * an http(s) origin. `null` is always a denial: an attacker can produce an
 * opaque origin at will.
 */
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

/** {@link parseOrigin}, host only. */
export function parseOriginHost(origin: string): string | null {
  return parseOrigin(origin)?.host ?? null;
}

/**
 * Whether the request reached us over TLS, as far as we can tell: the proxy's
 * `X-Forwarded-Proto` if it set one, else the socket.
 *
 * Used ONLY to refuse a downgrade — an `http://` origin claiming to be the same
 * origin as a request that arrived over `https`. It is deliberately not used to
 * *require* a scheme match: a proxy that terminates TLS and forgets the header
 * would then make every request look cross-origin and take the whole product
 * down. So a deployment that sets the header gets the stricter answer and one
 * that doesn't keeps today's behaviour, which is the safe direction for both.
 */
function requestIsSecure(request: FastifyRequest): boolean {
  const forwarded = headerValue(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim();
  if (forwarded) return forwarded.toLowerCase() === "https";
  return (request.socket as { encrypted?: boolean }).encrypted === true;
}

/** Split `host[:port]` into its parts, handling the `[::1]:3000` IPv6 form. */
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

/**
 * The host(s) that count as "this server" for a request: the browser-facing
 * `X-Forwarded-Host` when a proxy set one, and the `Host` header.
 *
 * Both, not one: ShipIt's OWN preview proxy rewrites `Host` to
 * `localhost:<containerPort>` on the way upstream and moves the browser-facing
 * name into `X-Forwarded-Host` (`preview-proxy.ts: buildUpstreamHeaders`). The
 * dogfood inner instance is reached exactly that way, so an inner orchestrator
 * that compared `Origin` against `Host` alone would refuse every write and
 * every WebSocket from its own UI.
 *
 * Trusting `X-Forwarded-Host` does not hand anything to the attacker this guard
 * is about. A web page cannot set it: a custom request header makes the request
 * non-simple, so the browser preflights, and the preflight is refused on its
 * `Origin` — `Access-Control-Allow-Headers` never names it either. A caller
 * that CAN set arbitrary headers is not a browser, and a non-browser caller is
 * `api-container-guard.ts`'s business, which runs after this and judges by
 * source IP rather than by anything in the request.
 */
export function selfHostsFrom(headers: IncomingHttpHeaders): string[] {
  const out: string[] = [];
  const forwarded = headerValue(headers["x-forwarded-host"]);
  // A chained proxy appends; the left-most entry is the browser's.
  const first = forwarded?.split(",")[0]?.trim();
  if (first) out.push(first.toLowerCase());
  if (typeof headers.host === "string" && headers.host) out.push(headers.host.toLowerCase());
  return out;
}

/**
 * Whether `origin` is an origin ShipIt owns for a request that arrived at one
 * of `selfHosts`. See the module docstring for why the comparison is against
 * the request's own host and ignores the scheme.
 */
export function isAllowedOrigin(
  origin: string,
  selfHosts: string[],
  policy: OriginPolicy,
  opts: { requestIsSecure?: boolean } = {},
): boolean {
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  const { host: originHost, protocol } = parsed;

  // Refuse a downgrade: an `http://` page is NOT the same origin as an `https://`
  // one, and treating it as such would let a page served over plain HTTP on the
  // same name read the HTTPS API. Only applied when we can tell we are on TLS
  // (see `requestIsSecure`).
  if (opts.requestIsSecure && protocol === "http:") return false;

  if (selfHosts.includes(originHost)) return true;

  if (policy.extraOrigins.some(
    (e) => e.host === originHost && (e.protocol === null || e.protocol === protocol),
  )) return true;

  // The dev client: same hostname, the one configured Vite port. Loopback
  // spellings count as the same hostname — the developer may have opened Vite
  // at `127.0.0.1:3000` while `VITE_API_HOST` says `localhost:3001`, and those
  // are the same machine by every meaning that matters here. Dev-only: the
  // whole branch is inert unless `CLIENT_DEV_PORT` is set.
  if (policy.devClientPort) {
    const wanted = splitHostPort(originHost);
    if (wanted.port === policy.devClientPort
      && selfHosts.some((self) => sameDevHostname(splitHostPort(self).hostname, wanted.hostname))) {
      return true;
    }
  }

  return false;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function sameDevHostname(a: string, b: string): boolean {
  if (a === b) return true;
  return LOOPBACK_NAMES.has(a) && LOOPBACK_NAMES.has(b);
}

/**
 * The verdict for a request that carries no `Origin` header, from
 * `Sec-Fetch-Site`. Absent → a non-browser caller (a session container's CLI,
 * curl, the deployment's own scripts) → allowed; the container guard is what
 * governs that direction.
 */
export function isAllowedWithoutOrigin(secFetchSite: string | undefined): boolean {
  if (!secFetchSite) return true;
  return secFetchSite === "same-origin" || secFetchSite === "none";
}

/**
 * The one shape of cross-site request that is normal rather than hostile: the
 * browser being redirected onto one of our routes by another site, which is how
 * every OAuth callback arrives. Requires the route to have opted in with
 * `config: { crossOriginNavigation: true }` AND the request to actually be a
 * top-level document navigation — a `fetch()` to the same path is not one, and
 * stays refused.
 *
 * Only reached when there is no `Origin` header, which a `GET` navigation omits.
 */
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

/** Paths the guard covers: the orchestrator's API and WebSocket surfaces. */
export function isOriginGuardedPath(pathname: string): boolean {
  return (
    pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/ws"
    || pathname.startsWith("/ws/")
  );
}

/**
 * Whether this request is for a guarded surface.
 *
 * Two independent answers, ORed, because each covers the other's blind spot:
 *
 *   - the **decoded** request path. Matching the raw one is not enough:
 *     find-my-way percent-decodes static segments when it resolves a route, so
 *     `GET /%61pi/bootstrap` runs the `/api/bootstrap` handler while
 *     `request.url` still reads `/%61pi/bootstrap`. Decoding here fails closed —
 *     it can only ever guard MORE paths, and over-guarding a path that resolves
 *     to nothing costs a 403 on a request that was going to 404.
 *   - the **matched route**, which is what the request actually reached, so it
 *     is immune to any spelling of the path at all.
 */
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

/**
 * CORS headers for a request, or `{}` when the origin is absent or not ours.
 * Exported so the SSE endpoint — which writes its headers straight onto the raw
 * response and therefore bypasses anything the hook set on `reply` — applies
 * exactly the same policy.
 */
export function corsHeadersFor(
  origin: string | undefined,
  headers: IncomingHttpHeaders,
  policy: OriginPolicy,
  opts: { requestIsSecure?: boolean } = {},
): Record<string, string> {
  if (!origin || !isAllowedOrigin(origin, selfHostsFrom(headers), policy, opts)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

/**
 * Whether a WebSocket upgrade may proceed.
 *
 * Checked explicitly at the route rather than left to CORS, because CORS does
 * not apply to WebSockets at all — the browser sends `Origin` on the handshake
 * and then honours whatever the server does with it. A CORS-only fix leaves
 * exactly this open. No `Sec-Fetch-Site` branch: browsers do not send those
 * headers on a WebSocket handshake, so "no Origin" here means a non-browser
 * client (the `ws` npm client sets none).
 */
export function isWebSocketOriginAllowed(
  headers: IncomingHttpHeaders,
  policy: OriginPolicy,
  opts: { requestIsSecure?: boolean } = {},
): boolean {
  const origin = headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  return isAllowedOrigin(origin, selfHostsFrom(headers), policy, opts);
}

// ---------------------------------------------------------------------------
// Preview-proxy registration (per app instance)
// ---------------------------------------------------------------------------

/**
 * Apps whose preview reverse proxy is registered, and which therefore hijack
 * every request to a `{uuid}--{port}.…` host before it can reach an API route.
 *
 * A `WeakSet` keyed by the Fastify instance rather than a module flag: several
 * apps are built in one process (integration tests), and a process-wide flag
 * set by one would silently widen the skip for the others.
 */
const appsWithPreviewProxy = new WeakSet<FastifyInstance>();

/** Called by the registration site, next to `registerPreviewProxy`. */
export function markPreviewProxyRegistered(app: FastifyInstance): void {
  appsWithPreviewProxy.add(app);
}

/**
 * Whether this app hijacks `{uuid}--{port}.…` hosts into the preview proxy, and
 * therefore never answers them itself. Read by `frame-guard.ts`, which skips
 * those responses for the same reason this file does: they are the previewed
 * app's, not ShipIt's.
 */
export function hasPreviewProxy(app: FastifyInstance): boolean {
  return appsWithPreviewProxy.has(app);
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Register the CORS + origin hook. MUST be the first `onRequest` hook so it
 * runs ahead of the container guard, the preview proxy and every handler.
 */
export function registerOriginGuard(
  app: FastifyInstance,
  policy: OriginPolicy = readOriginPolicyFromEnv(),
): void {
  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const host = request.headers.host;

    // Preview traffic is the previewed app's, not ours — and the proxy hook
    // below us hijacks it whatever its path.
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
    // Announce the dependency even when we send no `Access-Control-Allow-Origin`,
    // so a shared cache can't serve one origin's answer to another.
    if (origin) reply.header("Vary", "Origin");

    if (isGuardedRequest(request.url, request.routeOptions?.url)) {
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
