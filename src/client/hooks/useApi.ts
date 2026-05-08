/**
 * Lightweight fetch-based API client for HTTP endpoints.
 *
 * Replaces WebSocket request-response patterns for stateless reads and
 * simple mutations. Uses the same origin as the page (no CORS needed).
 */

import { useCallback, useMemo } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // couldn't parse error body — use statusText
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export interface UseApiReturn {
  /** GET request. Returns parsed JSON. */
  get: <T>(path: string) => Promise<T>;
  /** POST request with optional JSON body. Returns parsed JSON. */
  post: <T>(path: string, body?: unknown) => Promise<T>;
  /** PATCH request with JSON body. Returns parsed JSON. */
  patch: <T>(path: string, body: unknown) => Promise<T>;
  /** PUT request with JSON body. Returns parsed JSON. */
  put: <T>(path: string, body: unknown) => Promise<T>;
  /** DELETE request. Returns parsed JSON. */
  del: <T>(path: string) => Promise<T>;
}

/**
 * React hook that provides fetch-based API methods.
 * All paths are relative to the current origin (e.g., "/api/bootstrap").
 */
export function useApi(): UseApiReturn {
  const get = useCallback(async <T>(path: string): Promise<T> => {
    const res = await fetch(path, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    return handleResponse<T>(res);
  }, []);

  const post = useCallback(async <T>(path: string, body?: unknown): Promise<T> => {
    // Only advertise a JSON content-type when we're actually sending a JSON
    // body. Otherwise Fastify's JSON parser sees Content-Type: application/json
    // with a zero-length body and rejects with FST_ERR_CTP_EMPTY_JSON_BODY
    // (HTTP 400) before the route handler ever runs. This matters for routes
    // like /agent/kill and /container/restart which take no body.
    const hasBody = body !== undefined;
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (hasBody) headers["Content-Type"] = "application/json";
    const res = await fetch(path, {
      method: "POST",
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    return handleResponse<T>(res);
  }, []);

  const patch = useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(path, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
    });
    return handleResponse<T>(res);
  }, []);

  const put = useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(path, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
    });
    return handleResponse<T>(res);
  }, []);

  const del = useCallback(async <T>(path: string): Promise<T> => {
    const res = await fetch(path, {
      method: "DELETE",
      headers: { "Accept": "application/json" },
    });
    return handleResponse<T>(res);
  }, []);

  // Memoize the returned object so consumers can put `api` in a useEffect
  // dep array without the effect re-running on every render. The methods
  // themselves are already stable via useCallback, so the memoized object
  // is stable for the entire hook's lifetime. Without this, components
  // like SessionHealthStrip that depend on `api` end up firing fresh
  // network requests on every render — which compounds with stale-response
  // races during session switches and causes the agent-state label to
  // flicker between the previous and current session's status.
  return useMemo(() => ({ get, post, patch, put, del }), [get, post, patch, put, del]);
}
