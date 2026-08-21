/**
 * docs/201 / planning#131 — container ↔ browser trust boundary on the orchestrator API.
 *
 * Session containers reach the orchestrator over the Docker bridge network with
 * no caller authentication. Without a gate, a prompt-injected agent can `curl`
 * the full `/api/*` surface and mutate MCP servers, secrets, and other
 * account/global settings. This guard closes that gap.
 *
 * It identifies container-originated requests by their **TCP source IP** — the
 * same unforgeable signal the Docker proxy already trusts (`docker-proxy.ts`):
 * each session container has a unique bridge IP and `NET_RAW` is dropped so it
 * cannot spoof another. Browser/host callers (which arrive via the deployment
 * access layer, never from a session container's bridge IP) are left untouched.
 *
 * **That last sentence is a premise, not a fact, and it has to be maintained.**
 * "Not a known session container" is read as "browser or host", so a container
 * ShipIt runs but never registers is treated as MORE trusted than a session —
 * it skips all three layers below. docs/262's plugin install container found
 * that edge: it runs third-party code and is on its own network, so it is in
 * no session's IP map. {@link registerUntrustedContainerNetwork} is the
 * counterpart for that class of caller — a whole subnet declared untrusted, so
 * a container is denied from the moment it can send a packet rather than from
 * whenever the orchestrator gets around to registering its address. Any future
 * container that runs code ShipIt did not write belongs on such a network.
 *
 * **Only the session's own AGENT container gets the opt-in table below**
 * (planning#371). Every OTHER container of a session — a Compose service, the
 * project's own as much as a plugin's — is denied the whole `/api/*` surface,
 * with one exception admitted by a secret rather than by an address: the Tier C
 * egress decision query, made by the SNI proxy sidecar from inside the service's
 * network namespace (`egress-decision-auth.ts`). See §0.5 in the hook.
 *
 * For an agent-originated request the guard is **default-deny**: it passes
 * only `/api/sessions/<its-own-session>/<allowlisted-suffix>`, where the
 * allowlist is the set of routes that opted in with
 * `config: { containerAccessible: true }`. Three layers, in order:
 *
 *   1. Hard-deny backstop — high-value globals (`/api/secrets`, `/api/mcp-servers`,
 *      …) are 403'd regardless of any flag, so a mistaken opt-in can't expose them.
 *   2. Per-route opt-in — absence of `containerAccessible` (the default for every
 *      route) → 403. The decision lives next to each route definition.
 *   3. Own-session scope — the `/api/sessions/<id>/…` segment must equal the
 *      caller's own session; an allowed route reached for another session → 403.
 *
 * The set of opted-in routes is collected via an `onRoute` hook and exposed on
 * `app.containerAccessibleRoutes` so the golden-route-table test
 * (`api-container-guard.test.ts`) can assert it against a committed snapshot —
 * any new opt-in (or a route that newly matches) turns the build red.
 */

import type { FastifyInstance } from "fastify";
import { parsePreviewSubdomain } from "./preview-proxy.js";
import {
  isEgressDecisionPath,
  presentedEgressDecisionToken,
  verifyEgressDecisionToken,
} from "./egress-decision-auth.js";

// ---------------------------------------------------------------------------
// Fastify type augmentation
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * docs/201 — opt a route into the container-facing callback allowlist.
     * Only `/api/sessions/:id/...` routes the agent legitimately reaches (via
     * the worker's `OrchestratorClient` broker or the documented service/log
     * curls) should set this. Default-deny: omit it and containers get a 403.
     */
    containerAccessible?: boolean;
  }

  interface FastifyInstance {
    /**
     * `"<METHOD> <url>"` for every route that opted into container access.
     * Populated by `registerContainerOriginGuard`'s `onRoute` hook; read by the
     * golden-route-table guard test. HEAD (auto-added for GET) is excluded so
     * the set maps 1:1 to declared routes.
     */
    containerAccessibleRoutes: Set<string>;
  }
}

// ---------------------------------------------------------------------------
// Hard-deny backstop (§1)
// ---------------------------------------------------------------------------

/**
 * High-value global routes that a container must NEVER reach, checked before
 * the per-route opt-in and regardless of its result. These are already denied
 * by default-deny (they carry no `containerAccessible` flag); the backstop is
 * belt-and-suspenders so a future mistaken opt-in on one of them still can't
 * expose secrets/MCP config/account settings.
 */
const HARD_DENY_PREFIXES = [
  "/api/secrets",
  "/api/mcp-servers",
  "/api/provider-accounts",
  // docs/252 phase 2 — the same class of surface as `/api/provider-accounts`,
  // and it must carry the same backstop for the same reason: it manages the
  // user's credentials for every service.
  "/api/credential-routes",
  "/api/trackers",
  "/api/updates",
] as const;

/** Whether `pathname` is a hard-denied high-value global (exact or sub-path). */
export function isHardDeniedGlobal(pathname: string): boolean {
  return HARD_DENY_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

// ---------------------------------------------------------------------------
// Source-IP normalization (§ container-origin detection)
// ---------------------------------------------------------------------------

/**
 * Normalize a TCP peer address to a comparable IPv4/IPv6 string, stripping the
 * IPv6-mapped-IPv4 `::ffff:` prefix exactly as `docker-proxy.ts` does so the
 * lookup keys match. Returns `null` when the address is missing.
 *
 * Uses ONLY the real socket peer — never `X-Forwarded-For`, which a hostile
 * agent could set to impersonate the browser path.
 */
export function normalizeRemoteIp(remoteAddress: string | undefined): string | null {
  if (!remoteAddress) return null;
  return remoteAddress.replace(/^::ffff:/, "");
}

// ---------------------------------------------------------------------------
// Untrusted container networks (§0 — denied outright)
// ---------------------------------------------------------------------------

/**
 * IPv4 CIDRs whose traffic is denied the whole `/api/*` surface.
 *
 * A **subnet**, registered when the network is created, rather than a
 * per-container IP registered after the container starts: the container could
 * otherwise make its first request before the orchestrator learned its address,
 * and that request is exactly the one worth making.
 *
 * Process-wide rather than a guard dep, because the network is created lazily —
 * long after `buildApp()` wired this hook.
 */
const untrustedCidrs = new Set<string>();

/** Declare a subnet untrusted. Idempotent; a non-IPv4 CIDR is rejected. */
export function registerUntrustedContainerNetwork(cidr: string): boolean {
  if (!parseCidr(cidr)) return false;
  untrustedCidrs.add(cidr);
  return true;
}

/** Test seam — the registry is process-wide by design. */
export function clearUntrustedContainerNetworks(): void {
  untrustedCidrs.clear();
}

/** Whether `ip` falls in any registered untrusted subnet. */
export function isUntrustedContainerIp(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  if (addr === null) return false;
  for (const cidr of untrustedCidrs) {
    const parsed = parseCidr(cidr);
    if (parsed && (addr & parsed.mask) === (parsed.base & parsed.mask)) return true;
  }
  return false;
}

function parseCidr(cidr: string): { base: number; mask: number } | null {
  const [addr, bitsRaw] = cidr.split("/");
  const base = addr ? ipv4ToInt(addr) : null;
  const bits = Number.parseInt(bitsRaw ?? "", 10);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  // `-1 << 32` is 0 in JS's 32-bit shift, not the all-ones a /0 needs.
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return { base, mask };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value * 256) + n;
  }
  return value >>> 0;
}

/**
 * Extract the session id from the `/api/sessions/<id>/...` path segment, or
 * `null` if the path isn't session-scoped. Used for the own-session check.
 */
function sessionSegment(pathname: string): string | null {
  const parts = pathname.split("/");
  // ["", "api", "sessions", "<id>", ...]
  if (parts[1] === "api" && parts[2] === "sessions" && parts[3]) {
    return decodeURIComponent(parts[3]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guard registration
// ---------------------------------------------------------------------------

export interface ContainerGuardDeps {
  /**
   * Maps a bridge IP → its owning session container. When omitted (tests,
   * local/dogfood mode with no bridge network and no real containers), the
   * runtime guard is inert — there is no untrusted container origin to gate.
   */
  containerManager?: {
    getSessionByContainerIp(ip: string): { sessionId: string } | undefined;
    getSessionByAnyContainerIp?(ip: string): Promise<{ sessionId: string } | undefined>;
    isLikelySessionContainerIp?(ip: string): boolean;
  };
}

/**
 * Register the container-origin guard on `app`. MUST be called before the
 * domain route modules so its `onRoute` hook observes their registrations and
 * its `onRequest` hook runs ahead of every handler.
 *
 * The route-collection + decoration always run (so the golden test works in
 * test mode); only the runtime denial depends on `containerManager`.
 */
export function registerContainerOriginGuard(
  app: FastifyInstance,
  deps: ContainerGuardDeps,
): void {
  const containerAccessibleRoutes = new Set<string>();
  app.decorate("containerAccessibleRoutes", containerAccessibleRoutes);

  // Collect opted-in routes as they register. Fastify auto-adds a HEAD route
  // for every GET (inheriting its config); skip HEAD so the set maps 1:1 to
  // declared routes and the golden snapshot stays readable.
  app.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.config?.containerAccessible) return;
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      if (method === "HEAD") continue;
      containerAccessibleRoutes.add(`${method} ${routeOptions.url}`);
    }
  });

  const { containerManager } = deps;

  app.addHook("onRequest", async (request, reply) => {
    const ip = normalizeRemoteIp(request.socket.remoteAddress);

    // §0 — a declared-untrusted network gets nothing at all, not even the
    // per-route opt-in. Checked BEFORE the container-manager guard below, so it
    // holds in every runtime mode: the caller runs third-party code, and there
    // is no `/api/*` route it has a reason to reach.
    if (ip && isUntrustedContainerIp(ip)) {
      return reply
        .code(403)
        .send({ error: "This endpoint is not available to session containers." });
    }

    // Inert without an IP→session map (no real containers to gate).
    if (!containerManager) return;

    // The session's AGENT container, and — only when the IP is not that — any
    // OTHER container of a session: a Compose service, or a sidecar borrowing
    // one's network namespace. The two are deliberately kept apart (planning#371).
    // `getSessionByContainerIp` reads the manager's own record of the container
    // ShipIt created and runs the agent in; `getSessionByAnyContainerIp`
    // (`session-container.ts:1228`) resolves anything carrying the
    // `shipit-parent-session` label, which `compose-generator.ts:1113` stamps on
    // every generated service — the project's own and a plugin's alike.
    let caller: { sessionId: string } | undefined;
    let otherContainer: { sessionId: string } | undefined;
    try {
      caller = ip ? containerManager.getSessionByContainerIp(ip) : undefined;
      if (ip && !caller) {
        otherContainer = await containerManager.getSessionByAnyContainerIp?.(ip);
      }
    } catch {
      if (ip && containerManager.isLikelySessionContainerIp?.(ip)) {
        return reply.code(403).send({ error: "Container origin could not be verified." });
      }
      return;
    }
    // Neither → browser/host origin → unchanged.
    if (!caller && !otherContainer) return;

    const pathname = (request.url ?? "/").split("?")[0];
    const ownerSessionId = (caller ?? otherContainer)!.sessionId;

    // Preserve same-session preview traffic. The preview proxy handles this
    // host before any API route, but this guard's root hook runs first.
    //
    // The Host header is the caller's to set, so this looks like a way around
    // everything below — it is not: `registerPreviewProxy`'s own `onRequest`
    // hook (`preview-proxy.ts:639`) hijacks EVERY request whose Host matches
    // `{uuid}--{port}.`, whatever its path, and proxies it to the container. A
    // request that takes this early return therefore never reaches an API route.
    const previewOwner = parsePreviewSubdomain(request.headers.host)?.sessionId.toLowerCase();
    if (previewOwner === ownerSessionId.toLowerCase()) return;

    // §0.5 planning#371 — a Compose service container reaches NO `/api/*` route.
    //
    // Not a narrowed opt-in table, not a third caller class: a service needs no
    // orchestrator API at all. Reading it as "a container of this session" gave
    // any service — including a plugin's, which is third-party code the user
    // declared and does not necessarily read — the session's whole
    // container-accessible table, and `POST /api/sessions/:id/git/credential`
    // (`api-routes-github.ts:479`) is in it. The own-session comparison was no
    // obstacle: a service's workspace mount is a volume subpath, so
    // `/proc/self/mountinfo` names the full session id.
    //
    // The ONE query that legitimately comes from here is the Tier C egress
    // decision (docs/172) — issued by the SNI proxy sidecar INSIDE the service's
    // network namespace, which is exactly why no IP rule can separate the two.
    // It is admitted by the token that sidecar was launched with instead
    // (`egress-decision-auth.ts`), scoped to its own session by the token, not
    // by a string the caller supplies.
    if (otherContainer) {
      if (isEgressDecisionPath(pathname)) {
        const token = presentedEgressDecisionToken(request.headers);
        const scoped = new URLSearchParams((request.url ?? "").split("?")[1] ?? "").get("session");
        if (token && scoped === otherContainer.sessionId
          && await verifyEgressDecisionToken(otherContainer.sessionId, token)) {
          return;
        }
      }
      return reply
        .code(403)
        .send({ error: "This endpoint is not available to session containers." });
    }
    // Narrowed by the check above; the three layers below are the agent's.
    if (!caller) return;

    // §1 hard-deny backstop — independent of the opt-in flag.
    if (isHardDeniedGlobal(pathname)) {
      return reply
        .code(403)
        .send({ error: "This endpoint is not available to session containers." });
    }

    // §2 per-route opt-in — absence (the default) is a deny.
    if (request.routeOptions?.config?.containerAccessible !== true) {
      return reply
        .code(403)
        .send({ error: "This endpoint is not available to session containers." });
    }

    // §3 own-session scope — an allowed route reached for another session is denied.
    // Most container-facing routes are `/api/sessions/<id>/…`; a few instead carry
    // the session as a `?session=` query param (the Tier C egress decision query,
    // docs/172). Fall back to that — still the CALLER'S OWN session, so the scope
    // property is preserved; a mismatch (or neither present) is denied.
    const scoped =
      sessionSegment(pathname) ??
      new URLSearchParams((request.url ?? "").split("?")[1] ?? "").get("session");
    if (scoped !== caller.sessionId) {
      return reply
        .code(403)
        .send({ error: "Session containers may only act on their own session." });
    }
  });
}
