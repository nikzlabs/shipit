/**
 * SHI-311 — the session worker's HTTP trust boundary.
 *
 * A session worker binds `0.0.0.0:9100` and every agent container sits on the
 * SAME orchestrator bridge network, so until this module existed session A
 * could simply `POST http://agent-<first-12-of-B>:9100/…` and B's worker would
 * serve it. For `/agent-ops/*` that made the worker a **confused deputy**: it
 * relays to the orchestrator through its own `OrchestratorClient`, which
 * injects **B's** session id, so the orchestrator's container-origin guard
 * (`api-container-guard.ts`) saw a request from B's worker IP scoped to B and
 * correctly passed it. The guard there is sound for agent→orchestrator traffic;
 * the hole was agent→**another agent's worker**.
 *
 * The two callers a worker legitimately has are distinguishable, so the fix is
 * to tell them apart at the boundary rather than per route:
 *
 *  - **Its own agent**, which always dials `http://127.0.0.1:$WORKER_PORT`
 *    (`shim-common.ts:workerBaseUrl`, `mcp-shipit-bridge.ts`). Loopback inside a
 *    container's network namespace is reachable ONLY from that namespace — a
 *    peer container's `127.0.0.1` is its own. That makes the source address an
 *    unforgeable "this is my agent" signal, needing no shared secret at all.
 *  - **The orchestrator**, which arrives over the bridge from its own IP. It
 *    proves itself with a per-session bearer token ({@link WORKER_AUTH_HEADER})
 *    that the orchestrator injects as {@link WORKER_TOKEN_ENV} at container
 *    creation.
 *
 * Hence {@link LOOPBACK_ONLY_PREFIXES}: route groups that only the container's
 * own agent ever calls are pinned to loopback and are NOT reachable with a
 * token — so the SHI-311 fix does not depend on the token plumbing being right.
 * Everything else is orchestrator-facing and gated on the token.
 *
 * Shared by both layers so the header name, the loopback test, and the
 * loopback-only prefix list cannot drift between the worker that enforces them
 * (`session/worker-auth-guard.ts`) and the orchestrator that satisfies them
 * (`orchestrator/worker-auth.ts`).
 */

import crypto from "node:crypto";

/** Header carrying the per-session worker token on orchestrator→worker calls. */
export const WORKER_AUTH_HEADER = "x-shipit-worker-token";

/** Env var the orchestrator injects at container creation; read by the worker. */
export const WORKER_TOKEN_ENV = "SHIPIT_WORKER_TOKEN";

/**
 * Route prefixes served ONLY to the container's own agent over loopback. A
 * valid worker token does not open them — the orchestrator never calls these,
 * so accepting a token here would only widen the surface a leaked token buys.
 *
 *  - `/agent-ops/*` — the agent's broker to the orchestrator. Every route here
 *    is relayed with the worker's own trusted `SESSION_ID` injected, which is
 *    exactly what made cross-container access a privilege escalation (SHI-311):
 *    `branch/reset-to-base`, `session/rename`, `voice/note`, `bug/report`, …
 *  - `/present-files/*` — artifact bytes rendered for the agent's in-container
 *    Playwright browser. `present-view.ts` already documents these as
 *    "worker-local by design"; before this guard that was aspirational, and any
 *    session could read another session's presented files. (The orchestrator
 *    reads artifacts through `/present/:presentId/raw`, which is NOT in this
 *    set and stays token-gated.)
 */
export const LOOPBACK_ONLY_PREFIXES: readonly string[] = [
  "/agent-ops/",
  "/present-files/",
];

/**
 * Paths served to anyone that can reach the port. `/health` is a liveness probe
 * that returns a constant and is dialed by `waitForWorkerHealth` before the
 * orchestrator has a runner (and by container-level health checks), so gating it
 * would buy nothing and cost startup robustness.
 */
const UNAUTHENTICATED_PATHS: readonly string[] = ["/health"];

/** Whether `pathname` is one of the loopback-only route groups. */
export function isLoopbackOnlyPath(pathname: string): boolean {
  return LOOPBACK_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Normalize a TCP peer address for comparison, stripping the IPv6-mapped-IPv4
 * `::ffff:` prefix and any zone index (`%eth0`) — mirrors
 * `api-container-guard.ts:normalizeRemoteIp` so the two guards agree on what an
 * address "is". Returns `null` when the address is missing.
 */
export function normalizePeerAddress(remoteAddress: string | undefined | null): string | null {
  if (!remoteAddress) return null;
  return remoteAddress.replace(/^::ffff:/i, "").replace(/%.*$/, "");
}

/**
 * Whether a TCP peer address is this container's own loopback.
 *
 * Uses ONLY the real socket peer — never a forwarded header, which the caller
 * controls. A missing address is NOT loopback: `undefined` shows up on
 * already-destroyed sockets, and failing open there would reopen the hole.
 */
export function isLoopbackAddress(remoteAddress: string | undefined | null): boolean {
  const ip = normalizePeerAddress(remoteAddress);
  if (!ip) return false;
  if (ip === "::1") return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/** Generate a fresh per-session worker token. */
export function generateWorkerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Constant-time token comparison. Lengths are compared first (and a mismatch
 * returns immediately) because `timingSafeEqual` throws on unequal-length
 * buffers; the token length is fixed and public, so that leaks nothing.
 */
export function tokensMatch(expected: string | undefined, presented: unknown): boolean {
  if (!expected || typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface WorkerRequestOrigin {
  /** Path without querystring. */
  pathname: string;
  /** The real TCP peer address (`request.socket.remoteAddress`). */
  remoteAddress: string | undefined | null;
  /** Value of {@link WORKER_AUTH_HEADER} on the request, if any. */
  presentedToken: unknown;
  /**
   * The token this worker was configured with, or `undefined` when it has none.
   *
   * An unconfigured worker does NOT reject remote callers — see
   * {@link WorkerAuthDecision} for why that fallback is deliberate.
   */
  configuredToken: string | undefined;
}

export interface WorkerAuthDecision {
  allow: boolean;
  /** Why — surfaced in the 403 body and useful in tests. */
  reason:
    | "unauthenticated-path"
    | "loopback"
    | "token"
    | "no-token-configured"
    | "loopback-only"
    | "bad-token";
}

/**
 * Decide whether a worker request may proceed. Pure, so the policy is testable
 * without a socket.
 *
 * Order matters:
 *  1. `/health` — always open.
 *  2. Loopback-only groups — loopback or 403, regardless of any token. This is
 *     the SHI-311 fix proper and is enforced unconditionally.
 *  3. Loopback — the container's own agent; allowed everywhere else too. It
 *     already has a shell in this container, so gating it against its own worker
 *     would protect nothing.
 *  4. A matching token — the orchestrator.
 *  5. No token configured → allow, with the caller logging a warning.
 *
 * Step 5 is a deliberate compatibility fallback, not an oversight. Container env
 * is written by the orchestrator at creation, so an *older* orchestrator running
 * a *newer* worker image would create containers with no {@link WORKER_TOKEN_ENV}
 * and, under a fail-closed rule, every orchestrator→worker call would 403 —
 * bricking the session for a mid-deploy skew. Failing open there is exactly the
 * behavior that shipped before this guard, so it is a strict non-regression, and
 * the loopback-only rule in step 2 (which needs no token) still closes the
 * reported hole in that configuration.
 */
export function decideWorkerRequest(origin: WorkerRequestOrigin): WorkerAuthDecision {
  if (UNAUTHENTICATED_PATHS.includes(origin.pathname)) {
    return { allow: true, reason: "unauthenticated-path" };
  }

  const loopback = isLoopbackAddress(origin.remoteAddress);

  if (isLoopbackOnlyPath(origin.pathname)) {
    return loopback
      ? { allow: true, reason: "loopback" }
      : { allow: false, reason: "loopback-only" };
  }

  if (loopback) return { allow: true, reason: "loopback" };

  if (origin.configuredToken === undefined) {
    return { allow: true, reason: "no-token-configured" };
  }

  return tokensMatch(origin.configuredToken, origin.presentedToken)
    ? { allow: true, reason: "token" }
    : { allow: false, reason: "bad-token" };
}
