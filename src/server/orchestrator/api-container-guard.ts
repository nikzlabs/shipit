/**
 * docs/201 / SHI-129 — container ↔ browser trust boundary on the orchestrator API.
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
 * For a container-originated request the guard is **default-deny**: it passes
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
    // Inert without an IP→session map (no real containers to gate).
    if (!containerManager) return;

    const ip = normalizeRemoteIp(request.socket.remoteAddress);
    const caller = ip ? containerManager.getSessionByContainerIp(ip) : undefined;
    // Not a known session container → browser/host origin → unchanged.
    if (!caller) return;

    const pathname = (request.url ?? "/").split("?")[0];

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
    if (sessionSegment(pathname) !== caller.sessionId) {
      return reply
        .code(403)
        .send({ error: "Session containers may only act on their own session." });
    }
  });
}
