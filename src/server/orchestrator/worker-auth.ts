/**
 * SHI-311 — the orchestrator half of the worker trust boundary.
 *
 * The worker requires {@link WORKER_AUTH_HEADER} on every non-loopback request
 * (`session/worker-auth-guard.ts`). The orchestrator is the only such caller, so
 * every one of its worker calls has to carry the right per-session token.
 *
 * Those calls are spread across `worker-http.ts`, `sse-client.ts` and
 * `overlay-snapshot.ts` and reach ~35 call sites, most of which take a worker
 * base URL and nothing else. Threading a token parameter through all of them —
 * and through `setWorkerUrl`, `getWorkerUrl`, `fetchSnapshot`, the health prober
 * and the warm-pool pre-install — would put the burden on every future call site
 * to remember it, where forgetting means a 403 that looks like a dead container.
 *
 * So the token is looked up **by worker base URL** instead. That key is exact
 * and unique: a base URL is `http://<container bridge IP>:<worker port>`, one
 * live container per IP. The registry is written at the three points where a
 * `SessionContainer.workerUrl` becomes known — creation (`container-lifecycle`)
 * and the two adoption paths (`container-discovery`) — and cleared on teardown,
 * so its lifetime tracks the container's.
 *
 * The token itself is generated per container and injected as
 * {@link WORKER_TOKEN_ENV}. It is deliberately NOT derived from a long-lived
 * orchestrator secret: the container's own env is the source of truth, so an
 * orchestrator restart re-reads it from `docker inspect` at adoption rather than
 * depending on a key file surviving.
 *
 * Note the token is readable by the agent inside its own container (it is in the
 * worker's env). That grants nothing: loopback already reaches that worker's
 * whole surface, and the token is per-session, so it opens no other worker.
 */

import {
  WORKER_AUTH_HEADER,
  WORKER_TOKEN_ENV,
  generateWorkerToken,
} from "../shared/worker-auth.js";

export { generateWorkerToken };

/** worker base URL → the token that worker will accept. */
const tokensByWorkerUrl = new Map<string, string>();

/** Normalize a base URL so a trailing slash can't split one container in two. */
function key(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Record the token for a worker base URL. A `undefined` token (a container
 * created before this mechanism, adopted after an upgrade) clears any stale
 * entry rather than leaving the previous container's token bound to a reused IP.
 */
export function setWorkerAuthToken(baseUrl: string, token: string | undefined): void {
  if (!baseUrl) return;
  if (token) tokensByWorkerUrl.set(key(baseUrl), token);
  else tokensByWorkerUrl.delete(key(baseUrl));
}

/** Forget a worker's token — called when its container is destroyed. */
export function clearWorkerAuthToken(baseUrl: string): void {
  if (baseUrl) tokensByWorkerUrl.delete(key(baseUrl));
}

/** The token registered for `baseUrl`, if any. Exported for tests. */
export function getWorkerAuthToken(baseUrl: string): string | undefined {
  return tokensByWorkerUrl.get(key(baseUrl));
}

/**
 * Auth headers for a worker call, or `{}` when no token is registered (an
 * adopted legacy container, or a test worker). Spread into the outgoing header
 * object — the worker ignores an unexpected header, so sending it is always safe.
 */
export function workerAuthHeaders(baseUrl: string): Record<string, string> {
  const token = tokensByWorkerUrl.get(key(baseUrl));
  return token ? { [WORKER_AUTH_HEADER]: token } : {};
}

/**
 * Pull the worker token out of a container's `Config.Env` (the `KEY=value`
 * array `docker inspect` returns), for the adoption paths that meet a container
 * the current orchestrator process did not create.
 */
export function workerTokenFromContainerEnv(env: string[] | undefined): string | undefined {
  if (!env) return undefined;
  const prefix = `${WORKER_TOKEN_ENV}=`;
  for (const entry of env) {
    if (entry.startsWith(prefix)) {
      const value = entry.slice(prefix.length);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}
