/**
 * SHI-311 — the worker's `onRequest` gate. Policy lives in
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
 */

import type { FastifyInstance } from "fastify";
import {
  WORKER_AUTH_HEADER,
  WORKER_TOKEN_ENV,
  decideWorkerRequest,
} from "../shared/worker-auth.js";

export interface WorkerAuthGuardDeps {
  /**
   * The per-session token the orchestrator must present. Defaults to
   * `process.env[WORKER_TOKEN_ENV]`; `undefined` (no container env) leaves
   * remote callers ungated — see {@link decideWorkerRequest} for why.
   */
  token?: string | undefined;
  /** Log sink, injectable so tests don't write to the console. */
  log?: (message: string) => void;
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
  const configuredToken =
    deps.token ?? process.env[WORKER_TOKEN_ENV] ?? undefined;
  const log = deps.log ?? ((message: string) => console.warn(message));

  if (!configuredToken) {
    // Not fatal (see decideWorkerRequest step 5) but always worth a line: in a
    // real container this means the orchestrator that created it predates the
    // token, so only the loopback-only groups are protected.
    log(
      `[worker-auth] ${WORKER_TOKEN_ENV} is not set — orchestrator-facing routes are ungated. ` +
        "Loopback-only routes (/agent-ops, /present-files) are still enforced.",
    );
  }

  app.addHook("onRequest", async (request, reply) => {
    const pathname = (request.url ?? "/").split("?")[0];
    const decision = decideWorkerRequest({
      pathname,
      remoteAddress: request.socket.remoteAddress,
      presentedToken: request.headers[WORKER_AUTH_HEADER],
      configuredToken,
    });
    if (decision.allow) return;

    // One line per rejection: this is the signal that a session tried to reach
    // another session's worker, and it is the only place that is observable.
    log(
      `[worker-auth] denied ${request.method} ${pathname} from ` +
        `${request.socket.remoteAddress ?? "unknown"} (${decision.reason})`,
    );
    return reply.code(403).send(DENIED_BODY);
  });

  return configuredToken;
}
