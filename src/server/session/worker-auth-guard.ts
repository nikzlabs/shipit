/**
 * planning#313 — the worker's `onRequest` gate. Policy lives in
 * `shared/worker-auth.ts` ({@link decideWorkerRequest}); this module is the
 * Fastify wiring plus the one-time startup log.
 *
 * It MUST be registered before the route modules so the hook runs ahead of every
 * handler, including ones added later. There is intentionally no per-route
 * opt-in: a route is either in a loopback-only group (`/agent-ops/*`,
 * `/present-files/*`) or orchestrator-facing, and both classes are decided from
 * the path prefix. That keeps a newly-added agent-ops route protected by
 * construction — the failure mode of the orchestrator's route-level allowlist
 * (forgetting the annotation) can't happen here.
 *
 * planning#421 adds {@link requireWorkerToken}: the container process resolves the
 * token from its environment and refuses to start without one, so "a worker
 * serving with no token" is a state a container cannot be in. The guard's own
 * behaviour for a tokenless worker (refuse every remote caller) is the second
 * layer, not the first.
 */

import type { FastifyInstance } from "fastify";
import {
  WORKER_AUTH_HEADER,
  WORKER_TOKEN_ENV,
  decideWorkerRequest,
  routerPathname,
} from "../shared/worker-auth.js";

export interface WorkerAuthGuardDeps {
  /**
   * The per-session token the orchestrator must present, or `undefined` for a
   * worker that has none — which since planning#421 means every remote caller is
   * refused ({@link decideWorkerRequest} step 6).
   *
   * There is deliberately NO fallback to `process.env` here. The container
   * process reads {@link WORKER_TOKEN_ENV} once, in {@link requireWorkerToken},
   * and refuses to start without it; leaving a second reader in the guard is how
   * a test meaning "a worker with no token" silently picked up the ambient
   * container token instead (it passed in CI and failed in-container). One
   * reader, at the one place that knows it is a real container.
   */
  token?: string | undefined;
  /** Log sink, injectable so tests don't write to the console. */
  log?: (message: string) => void;
}

/**
 * Error thrown by {@link requireWorkerToken}. A named type so the entry point
 * can report it as a configuration fault rather than a crash.
 */
export class MissingWorkerTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingWorkerTokenError";
  }
}

/**
 * planning#421 — resolve the container's worker token, or refuse.
 *
 * The container entry point calls this BEFORE building a worker, so a container
 * that came up without {@link WORKER_TOKEN_ENV} dies at startup instead of
 * serving its orchestrator-facing surface to anything that can reach it on the
 * session subnet. That is the honest reading of "fail closed": a worker that
 * cannot authenticate its orchestrator cannot tell it from a peer container, so
 * there is no useful state for it to serve from. The process exits before it
 * listens, so `/health` never answers and creation fails at
 * `waitForWorkerHealth` (`container-lifecycle.ts:691`, 30s) with the container's
 * own logs carrying one line that names the variable.
 *
 * An EMPTY value is treated as absent, matching the orchestrator's
 * `workerTokenFromContainerEnv` (which maps `SHIPIT_WORKER_TOKEN=` to
 * `undefined`, and so sends no header). Accepting `""` as a token would 403
 * every orchestrator call instead — a worker that is up but unusable, which is
 * strictly worse to diagnose than one that refused to start.
 */
export function requireWorkerToken(env: NodeJS.ProcessEnv): string {
  const token = env[WORKER_TOKEN_ENV];
  if (!token) {
    throw new MissingWorkerTokenError(
      `${WORKER_TOKEN_ENV} is not set. The orchestrator injects it at container ` +
        "creation and presents it on every call, so a worker without it cannot " +
        "distinguish its orchestrator from another session's container. Refusing " +
        "to start rather than serving the orchestrator-facing routes unauthenticated.",
    );
  }
  return token;
}

/** Message body for a rejected request. Deliberately says nothing specific. */
const DENIED_BODY = {
  error: "This session worker does not serve requests from outside its own session.",
} as const;

/**
 * Register the worker's origin guard on `app`.
 *
 * Returns the token actually in force (or `undefined`), which the caller can
 * assert on in tests.
 */
export function registerWorkerAuthGuard(
  app: FastifyInstance,
  deps: WorkerAuthGuardDeps = {},
): string | undefined {
  const configuredToken = deps.token ? deps.token : undefined;
  const log = deps.log ?? ((message: string) => console.warn(message));

  if (!configuredToken) {
    // In a container this is unreachable — `requireWorkerToken` refuses to start
    // the process first — so reaching it means an in-process worker (a test) or
    // a future embedding that skipped that check. Say what the consequence is.
    log(
      `[worker-auth] no ${WORKER_TOKEN_ENV} configured — every non-loopback caller ` +
        "will be refused. Only this container's own agent can reach this worker.",
    );
  }

  app.addHook("onRequest", async (request, reply) => {
    const rawUrl = request.url ?? "/";
    const decision = decideWorkerRequest({
      // The RAW target. Deriving a pathname here is what produced the fragment
      // and absolute-form bypasses; `decideWorkerRequest` owns that now.
      url: rawUrl,
      remoteAddress: request.socket.remoteAddress,
      presentedToken: request.headers[WORKER_AUTH_HEADER],
      configuredToken,
    });
    if (decision.allow) return;

    // One line per rejection: this is the signal that a session tried to reach
    // another session's worker, and it is the only place that is observable.
    // Logs the canonical path, so the line names the route actually targeted
    // rather than whatever spelling the caller used to reach it.
    log(
      `[worker-auth] denied ${request.method} ${routerPathname(rawUrl)} from ` +
        `${request.socket.remoteAddress ?? "unknown"} (${decision.reason})`,
    );
    return reply.code(403).send(DENIED_BODY);
  });

  return configuredToken;
}
