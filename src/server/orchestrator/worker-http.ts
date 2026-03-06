/**
 * HTTP helpers for communicating with session worker containers.
 * Extracted from container-session-runner.ts for single-responsibility.
 */

import http from "node:http";

export async function workerPost(baseUrl: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error((parsed.error as string) ?? `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Invalid response from worker: ${data}`));
          }
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function workerGet(baseUrl: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error((parsed.error as string) ?? `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Invalid response from worker: ${data}`));
          }
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.end();
  });
}
