/**
 * Lightweight fetch-based API client for HTTP endpoints.
 *
 * Replaces WebSocket request-response patterns for stateless reads and
 * simple mutations. Uses the same origin as the page (no CORS needed).
 */

import { useCallback } from "react";

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
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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

  return { get, post, patch, put, del };
}
