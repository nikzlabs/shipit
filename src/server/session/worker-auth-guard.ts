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
   * The per-session token the orchestrator must present. Falls back to
   * {@link WorkerAuthGuardDeps.env}`[WORKER_TOKEN_ENV]` when nullish — which is
   * the REAL container path, not a test convenience: `SessionWorker` always
   * passes this key and its own `workerToken` dep is unset in the standalone
   * entry point, so the env read is how a live worker gets its token. Resolving
   * to `undefined` (no container env) leaves remote callers ungated — see
   * {@link decideWorkerRequest} step 6 for why that is deliberate.
   *
   * SHI-239 raises the stakes on the `env` dep below rather than changing this
   * shape: the token now gates the lifecycle routes too, so a test-built worker
   * that picked the value out of the ambient environment would 403 its own
   * loopback `/agent/start`. The suite-wide strip in `server-test-setup.ts` is
   * what keeps that from happening.
   */
  token?: string | undefined;
  /**
   * Environment the token falls back to. Defaults to `process.env`; injectable
   * so a caller can exercise the "no token configured" branch **hermetically**.
   * Without it the branch is untestable inside a session container, where
   * `WORKER_TOKEN_ENV` is always set and an explicit `token: undefined` falls
   * straight through to the ambient token. Same shape as
   * `egressEnforceEnabled(env)`.
   */
  env?: NodeJS.ProcessEnv;
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
  // An EMPTY env value means "no token", matching the orchestrator's
  // `workerTokenFromContainerEnv` (which maps `SHIPIT_WORKER_TOKEN=` to
  // `undefined`). Without the emptiness check the two halves disagree: the
  // orchestrator would send no header while the worker held `""` as its
  // expected token, and since `tokensMatch("", …)` is always false every
  // orchestrator→worker call would 403 — the exact bricked session that step 5
  // of `decideWorkerRequest` exists to prevent, reached through an empty value
  // instead of an absent one.
  const fromEnv = (deps.env ?? process.env)[WORKER_TOKEN_ENV];
  const configuredToken = deps.token ?? (fromEnv ? fromEnv : undefined);
  const log = deps.log ?? ((message: string) => console.warn(message));

  if (!configuredToken) {
    // Not fatal (see decideWorkerRequest step 6) but always worth a line: in a
    // real container this means the orchestrator that created it predates the
    // token, so only the loopback-only groups are protected.
    log(
      `[worker-auth] ${WORKER_TOKEN_ENV} is not set — orchestrator-facing and lifecycle ` +
        "routes are ungated. Loopback-only routes (/agent-ops, /present-files) are still enforced.",
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
