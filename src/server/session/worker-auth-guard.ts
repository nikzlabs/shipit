// Register before route modules so every handler receives the guard.

import type { FastifyInstance } from "fastify";
import {
  WORKER_AUTH_HEADER,
  WORKER_TOKEN_ENV,
  decideWorkerRequest,
  routerPathname,
} from "../shared/worker-auth.js";

export interface WorkerAuthGuardDeps {
  // No environment fallback: undefined must exercise the tokenless policy in tests.
  token?: string | undefined;
  log?: (message: string) => void;
}

export class MissingWorkerTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingWorkerTokenError";
  }
}

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

const DENIED_BODY = {
  error: "This session worker does not serve requests from outside its own session.",
} as const;

export function registerWorkerAuthGuard(
  app: FastifyInstance,
  deps: WorkerAuthGuardDeps = {},
): string | undefined {
  const configuredToken = deps.token ? deps.token : undefined;
  const log = deps.log ?? ((message: string) => console.warn(message));

  if (!configuredToken) {
    log(
      `[worker-auth] no ${WORKER_TOKEN_ENV} configured — every non-loopback caller ` +
        "will be refused. Only this container's own agent can reach this worker.",
    );
  }

  app.addHook("onRequest", async (request, reply) => {
    const rawUrl = request.url ?? "/";
    const decision = decideWorkerRequest({
      // Pass the raw target; policy owns canonicalization to match the router.
      url: rawUrl,
      remoteAddress: request.socket.remoteAddress,
      presentedToken: request.headers[WORKER_AUTH_HEADER],
      configuredToken,
    });
    if (decision.allow) return;

    log(
      `[worker-auth] denied ${request.method} ${routerPathname(rawUrl)} from ` +
        `${request.socket.remoteAddress ?? "unknown"} (${decision.reason})`,
    );
    return reply.code(403).send(DENIED_BODY);
  });

  return configuredToken;
}
