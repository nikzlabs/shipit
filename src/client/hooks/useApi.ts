

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

  get: <T>(path: string) => Promise<T>;

  post: <T>(path: string, body?: unknown) => Promise<T>;

  patch: <T>(path: string, body: unknown) => Promise<T>;

  put: <T>(path: string, body: unknown) => Promise<T>;

  del: <T>(path: string) => Promise<T>;
}

export function useApi(): UseApiReturn {
  const get = useCallback(async <T>(path: string): Promise<T> => {
    const res = await fetch(path, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    return handleResponse<T>(res);
  }, []);

  const post = useCallback(async <T>(path: string, body?: unknown): Promise<T> => {

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

  return useMemo(() => ({ get, post, patch, put, del }), [get, post, patch, put, del]);
}
