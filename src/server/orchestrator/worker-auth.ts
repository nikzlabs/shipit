import {
  WORKER_AUTH_HEADER,
  WORKER_TOKEN_ENV,
  generateWorkerToken,
} from "../shared/worker-auth.js";

export { generateWorkerToken };

// Creation and adoption register tokens; teardown clears them before bridge IP reuse.
const tokensByWorkerUrl = new Map<string, string>();

function key(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// An adopted legacy container must clear any token left for its reused IP.
export function setWorkerAuthToken(baseUrl: string, token: string | undefined): void {
  if (!baseUrl) return;
  if (token) tokensByWorkerUrl.set(key(baseUrl), token);
  else tokensByWorkerUrl.delete(key(baseUrl));
}

export function clearWorkerAuthToken(baseUrl: string): void {
  if (baseUrl) tokensByWorkerUrl.delete(key(baseUrl));
}

export function getWorkerAuthToken(baseUrl: string): string | undefined {
  return tokensByWorkerUrl.get(key(baseUrl));
}

export function workerAuthHeaders(baseUrl: string): Record<string, string> {
  const token = tokensByWorkerUrl.get(key(baseUrl));
  return token ? { [WORKER_AUTH_HEADER]: token } : {};
}

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
