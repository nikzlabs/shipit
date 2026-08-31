/**
 * planning#313 — the session worker's HTTP trust boundary.
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
 * token — so the planning#313 fix does not depend on the token plumbing being right.
 * Everything else is orchestrator-facing and gated on the token.
 *
 * planning#241 adds the mirror-image group, {@link LIFECYCLE_PATHS}: routes only the
 * ORCHESTRATOR ever calls, where loopback is explicitly NOT sufficient. Loopback
 * is an identity signal ("something in this container"), not an authorization
 * one, and `/agent/*` is the one place where the difference has teeth — see
 * {@link LIFECYCLE_PATHS} for the incident it prevents.
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
 *    exactly what made cross-container access a privilege escalation (planning#313):
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
 * planning#241 — lifecycle-mutating routes, which a loopback caller may NOT reach
 * without the token. The inverse of {@link LOOPBACK_ONLY_PREFIXES}: only the
 * orchestrator has any business starting, killing or steering the resident
 * agent, so "came from inside this container" buys nothing here.
 *
 * The hazard is an ACCIDENT, not an attacker. `container-session-runner.ts`
 * treats two consecutive 409s on `/agent/start` as a stale worker agent and
 * clears it with `/agent/kill` (docs/142 Problem B2). So any in-container
 * process that POSTs `127.0.0.1:$WORKER_PORT/agent/start` — most famously an
 * integration-test fixture whose `ContainerSessionRunner` pointed at a live
 * worker address (prod incident 2026-07-25, session 6e1e22fa) — collides with
 * the resident agent and gets it SIGTERMed mid-turn. With this set the stray
 * caller is refused BEFORE the 409, so the recovery loop never arms.
 *
 * PR #1741 fenced that specific trigger (fixtures now use dead loopback ports,
 * plus a static tripwire in `dead-worker-port.test.ts`); this closes the surface
 * behind it, which matters because ShipIt dogfoods itself and the agent
 * routinely runs the very suite that caused the incident.
 *
 * Exact paths, not a prefix: `GET /agent/status` is a health/adoption probe and
 * must stay open, and `/agent-ops/*` is a different group entirely (it is
 * loopback-ONLY — the agent's legitimate route to `/agent/spawn` is
 * `agent-ops-routes.ts` relaying through the orchestrator, which comes back over
 * the bridge holding the token).
 *
 * Scope note: this contains accidents, not a determined same-UID process. The
 * worker's env is inherited by the agent it spawns, so anything in the container
 * can read {@link WORKER_TOKEN_ENV} and present it deliberately. Container
 * isolation remains the boundary for that; an accidental caller does not set an
 * auth header.
 */
export const LIFECYCLE_PATHS: ReadonlySet<string> = new Set([
  "/agent/start",
  "/agent/interrupt",
  "/agent/kill",
  "/agent/spawn",
  "/agent/stdin",
  "/agent/message",
  "/agent/permission-mode",
  "/agent/compact",
  "/agent/permission/resolve",
]);

/**
 * Paths served to anyone that can reach the port. `/health` is a liveness probe
 * that returns a constant and is dialed by `waitForWorkerHealth` before the
 * orchestrator has a runner (and by container-level health checks), so gating it
 * would buy nothing and cost startup robustness.
 */
const UNAUTHENTICATED_PATHS: readonly string[] = ["/health"];

/**
 * The spellings of `pathname` that could reach a handler, so a protected route
 * cannot be smuggled past the guard in percent-encoded form.
 *
 * Fastify's router canonicalizes before matching: `find-my-way` runs the path
 * through `decodeURI` when it contains an escape it will not defer to per-param
 * decoding (`lib/url-sanitizer.js:safeDecodeURI`). So `POST /agent/%6bill`
 * matches the `/agent/kill` handler, and a guard comparing only the raw URL sees
 * an unrecognized path and waves it through — verified as a live bypass before
 * this existed, on BOTH this module's route groups.
 *
 * Rather than replicate `find-my-way`'s conditional (which decides *whether* to
 * decode from the escapes present, and which is theirs to change), this returns
 * every candidate and the callers deny if ANY of them is protected. That is
 * deliberately conservative: it can only ever add a denial, never remove one. An
 * over-denial costs a 403 on a path the router would have 404'd anyway.
 *
 * `decodeURI` — not `decodeURIComponent` — because that is what the router uses:
 * it leaves reserved characters like `%2F` encoded, which is exactly why
 * `/agent%2Fkill` does NOT reach the kill handler and must not be denied here.
 */
/**
 * The path Fastify's router will actually match, derived from the raw request
 * target exactly as `find-my-way` derives it.
 *
 * This lives here, not at the Fastify wiring, because deriving it wrongly is the
 * bug class this module keeps hitting: the guard classifies one string while the
 * router dispatches on another. Two vectors were live before this existed, both
 * reproduced against a real server on a real socket (`app.inject` normalizes
 * them away, so an inject-only probe misses both):
 *
 *  - **Fragment.** The guard split only on `?`, but `find-my-way` treats a raw
 *    `#` as a delimiter too (`lib/url-sanitizer.js`, charCode 35). So
 *    `POST /agent/kill#x` classified as the unprotected `/agent/kill#x` and
 *    dispatched to the `/agent/kill` handler. It defeated the decode fix as
 *    well: `/agent/%6bill#x` reached the same handler.
 *  - **Absolute-form request target.** `find-my-way` strips scheme+authority
 *    when the target does not begin with `/` (`index.js`, `FULL_PATH_REGEXP`),
 *    while the guard classified the whole absolute URL. So
 *    `POST http://127.0.0.1:9100/agent/kill` was served.
 *
 * `;` is deliberately NOT a delimiter here: `find-my-way`'s `useSemicolonDelimiter`
 * defaults to false and the worker passes no override, so `/agent/kill;x=1`
 * genuinely 404s rather than reaching the handler. Splitting on it would deny
 * paths the router never routes — harmless for lifecycle paths, but it would
 * also truncate a legitimate `/present-files/<id>` whose id contains one.
 *
 * The delimiter scan starts at index 1, mirroring `safeDecodeURI`'s loop, so a
 * target that IS a delimiter at position 0 is left alone and 404s as it does now.
 */
export function routerPathname(rawUrl: string): string {
  let path = rawUrl.length > 0 ? rawUrl : "/";
  // Only when it does not already start with `/` — same condition as the router.
  if (path.charCodeAt(0) !== 47) path = path.replace(/^https?:\/\/.*?\//, "/");
  const cut = path.slice(1).search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut + 1);
}

function pathVariants(pathname: string): string[] {
  try {
    const decoded = decodeURI(pathname);
    return decoded === pathname ? [pathname] : [pathname, decoded];
  } catch {
    // A malformed escape (`%zz`). The router answers 400 without routing it, so
    // the raw form is the only spelling that could ever have matched.
    return [pathname];
  }
}

/** Whether `pathname` is one of the loopback-only route groups. */
export function isLoopbackOnlyPath(pathname: string): boolean {
  return pathVariants(pathname).some((candidate) =>
    LOOPBACK_ONLY_PREFIXES.some((prefix) => candidate.startsWith(prefix)),
  );
}

/**
 * Whether `pathname` is a lifecycle-mutating route ({@link LIFECYCLE_PATHS}).
 *
 * Checks every spelling from {@link pathVariants}, and strips a trailing slash.
 * Fastify's router does not strip one (`ignoreTrailingSlash` is off, so
 * `/agent/kill/` 404s), which makes that part belt-and-braces — but the guard
 * deciding membership differently from the router is exactly the mismatch that
 * the encoded-path bypass was.
 */
export function isLifecyclePath(pathname: string): boolean {
  return pathVariants(pathname).some((candidate) => {
    const normalized = candidate.length > 1 && candidate.endsWith("/")
      ? candidate.slice(0, -1)
      : candidate;
    return LIFECYCLE_PATHS.has(normalized);
  });
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
  /**
   * The RAW request target, exactly as Fastify received it (`request.url`) —
   * querystring, fragment and absolute form all still attached.
   *
   * Deliberately not a pre-stripped pathname: callers that derived one
   * themselves is how both the fragment and absolute-form bypasses happened.
   * {@link routerPathname} canonicalizes it here, so the guard and the router
   * cannot disagree about which path a request is for. Passing an
   * already-derived pathname is still safe — the derivation is idempotent.
   */
  url: string;
  /** The real TCP peer address (`request.socket.remoteAddress`). */
  remoteAddress: string | undefined | null;
  /** Value of {@link WORKER_AUTH_HEADER} on the request, if any. */
  presentedToken: unknown;
  /**
   * The token this worker was configured with, or `undefined` when it has none.
   *
   * An unconfigured worker rejects every remote caller (planning#421). In a
   * container that state is unreachable — the worker entry point refuses to
   * start without {@link WORKER_TOKEN_ENV} — so `undefined` here means an
   * in-process worker built by a test.
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
    | "lifecycle-needs-token"
    | "bad-token";
}

/**
 * Decide whether a worker request may proceed. Pure, so the policy is testable
 * without a socket.
 *
 * Order matters:
 *  1. `/health` — always open.
 *  2. Loopback-only groups — loopback or 403, regardless of any token. This is
 *     the planning#313 fix proper and is enforced unconditionally.
 *  3. Lifecycle routes on a token-configured worker — the token decides, and
 *     loopback does NOT substitute for it (planning#241). Sits ahead of step 4
 *     precisely because that step would otherwise wave the caller through.
 *  4. Loopback — the container's own agent; allowed on everything that is left.
 *  5. A matching token — the orchestrator.
 *  6. No token configured → DENY every remaining (i.e. remote) caller.
 *
 * Step 4 is narrower than it reads. Loopback is trusted for the REST of the
 * surface because the agent already has a shell in this container, so gating it
 * against its own worker's file/service/terminal routes would protect nothing it
 * cannot do directly. `/agent/*` is the exception that motivated step 3: there
 * the worker holds something the caller does NOT otherwise have — the live agent
 * process and the orchestrator's belief about it — and a stray `/agent/start`
 * gets that agent killed (see {@link LIFECYCLE_PATHS}).
 *
 * planning#421 — step 6 used to ALLOW, as a compatibility fallback for a container
 * created by an orchestrator that predates {@link WORKER_TOKEN_ENV}. That made a
 * tokenless worker serve its whole orchestrator-facing surface to anything on the
 * session subnet. `/install` is the sharpest case: `compose-service-egress.ts`
 * lets a contained plugin service reach the agent container, so what keeps it
 * from POSTing the worker's `/install` directly is that no plugin container
 * holds a token. A guarantee stated in a plan is not something a future change
 * can fail, so it is pinned here instead, by a rule with a test on it.
 *
 * Failing closed cannot brick the skew case that fallback was written for. A
 * container that outlives a deploy keeps running the image it was created from,
 * so an *older* container is never running *this* code. The reverse pairing —
 * this worker image created by an orchestrator with no token to inject — is
 * reachable only inside a deploy's build window (`deployment/vps/deploy.sh`
 * builds the image before restarting the orchestrator), and only on an upgrade
 * that crosses v0.3.0, where the old orchestrator predates the token entirely.
 * There the worker exits before it listens, so creating that session fails at
 * `waitForWorkerHealth` instead of coming up unauthenticated, and the next
 * attempt after the deploy succeeds. Nothing already running is affected.
 *
 * Step 3 still defers to the tokenless case: an unconfigured worker keeps
 * serving lifecycle routes over loopback, which is what lets in-process tests
 * build a `SessionWorker` with no token and drive `/agent/start` over 127.0.0.1.
 * That is not a hole — a tokenless worker is now unreachable from off-box.
 */
export function decideWorkerRequest(origin: WorkerRequestOrigin): WorkerAuthDecision {
  // Canonicalized HERE rather than by the caller — see WorkerRequestOrigin.url.
  const pathname = routerPathname(origin.url);

  if (UNAUTHENTICATED_PATHS.includes(pathname)) {
    return { allow: true, reason: "unauthenticated-path" };
  }

  const loopback = isLoopbackAddress(origin.remoteAddress);

  if (isLoopbackOnlyPath(pathname)) {
    return loopback
      ? { allow: true, reason: "loopback" }
      : { allow: false, reason: "loopback-only" };
  }

  // planning#241 — ahead of the blanket loopback allow below, so a caller inside this
  // container cannot start/kill the resident agent just by being inside it.
  if (origin.configuredToken !== undefined && isLifecyclePath(pathname)) {
    return tokensMatch(origin.configuredToken, origin.presentedToken)
      ? { allow: true, reason: "token" }
      : { allow: false, reason: "lifecycle-needs-token" };
  }

  if (loopback) return { allow: true, reason: "loopback" };

  // planning#421 — fail CLOSED. A worker that cannot authenticate its orchestrator
  // cannot tell it apart from a peer container, so it refuses both.
  if (origin.configuredToken === undefined) {
    return { allow: false, reason: "no-token-configured" };
  }

  return tokensMatch(origin.configuredToken, origin.presentedToken)
    ? { allow: true, reason: "token" }
    : { allow: false, reason: "bad-token" };
}
