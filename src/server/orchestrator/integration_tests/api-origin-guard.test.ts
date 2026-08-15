/**
 * planning#370 — the browser-origin boundary, exercised against a real listening
 * orchestrator rather than through `app.inject()`.
 *
 * `inject()` cannot prove the part that matters most: the WebSocket handshake
 * never goes through Fastify's HTTP injection path, and CORS does not protect
 * WebSockets at all. So this file dials real sockets.
 *
 * The four callers the boundary has to tell apart:
 *   1. the ShipIt UI itself           — same origin, allowed
 *   2. a preview page / any other site — cross origin, refused (read AND write)
 *   3. a session container's CLI       — no browser headers at all, allowed
 *   4. a WebSocket upgrade             — checked explicitly, both ways
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import WebSocket from "ws";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  urlPath: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${urlPath}`,
      { method: opts.method ?? "GET", headers: opts.headers ?? {} },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => { buf += c.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Resolves to the close code (or `"open"` when the handshake succeeded). */
function dialWs(
  port: number,
  sessionId: string,
  origin?: string,
  /** Overrides the `Host` header — how a rebound handshake reaches us. */
  host?: string,
): Promise<number | "open"> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, {
      ...(origin ? { origin } : {}),
      ...(host ? { headers: { Host: host } } : {}),
    });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("ws dial timed out")); }, 5000);
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve("open");
    });
    ws.on("close", (code) => { clearTimeout(timer); resolve(code); });
    // A refused UPGRADE surfaces as an error, not a close — resolve on the
    // HTTP status so the assertion reads the same either way.
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      // `close` / `unexpected-response` already resolved in the cases we assert.
      reject(err);
    });
  });
}

describe("Integration: browser-origin boundary on the orchestrator API", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionId: string;
  /** The origin the browser would report for this very server. */
  let selfOrigin: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-origin-guard-"));

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
    selfOrigin = `http://127.0.0.1:${port}`;

    const created = await request(port, "/api/_test/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    sessionId = (JSON.parse(created.body) as { sessionId: string }).sessionId;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // best effort
    }
  });

  it("allows the ShipIt UI's own same-origin read and reflects its origin", async () => {
    const res = await request(port, "/api/bootstrap", {
      headers: { Origin: selfOrigin, "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(selfOrigin);
  });

  it("refuses a read from another site, and reflects nothing", async () => {
    const res = await request(port, "/api/bootstrap", {
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("refuses a read from a preview page on a subdomain of its own host", async () => {
    const res = await request(port, `/api/sessions/${sessionId}/history`, {
      headers: {
        Origin: `http://${sessionId}--5173.127.0.0.1.nip.io:${port}`,
        "Sec-Fetch-Site": "same-site",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a cross-site write", async () => {
    const res = await request(port, `/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a percent-encoded spelling of an API path", async () => {
    // The route resolves (find-my-way decodes static segments) but the raw URL
    // does not start with `/api/` — so this is a real bypass of a naive prefix
    // test, and it must 403 rather than answer.
    const res = await request(port, "/%61pi/bootstrap", {
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("sessions");
  });

  it("still lets an OAuth provider redirect the browser onto the MCP callback", async () => {
    // The real route, reached the way it is actually reached: a cross-site
    // top-level navigation with no `Origin`. A guard that refuses every
    // cross-site request breaks MCP OAuth outright (found in review).
    const res = await request(port, "/api/mcp-servers/oauth/callback?code=C&state=nope", {
      headers: {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
    });
    // The route rejects the unknown `state` on its own terms — what matters
    // here is that it RAN, rather than being 403'd by the origin guard.
    expect(res.status).not.toBe(403);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("does not let that exemption serve a cross-origin fetch of the same path", async () => {
    const res = await request(port, "/api/mcp-servers/oauth/callback?code=C&state=nope", {
      headers: {
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      },
    });
    expect(res.status).toBe(403);
  });

  it("allows a session container's call, which carries no browser headers", async () => {
    const res = await request(port, "/api/bootstrap");
    expect(res.status).toBe(200);
  });

  it("leaves the SSE stream reachable same-origin and refuses it cross-origin", async () => {
    const foreign = await request(port, "/api/events", {
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(foreign.status).toBe(403);

    // Same-origin: the stream opens, so read the headers and drop it.
    const opened = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/api/events`,
        { headers: { Origin: selfOrigin, "Sec-Fetch-Site": "same-origin" } },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.headers["access-control-allow-origin"]).toBe(selfOrigin);
    opened.destroy();
  });

  it("accepts a WebSocket upgrade from its own origin", async () => {
    await expect(dialWs(port, sessionId, selfOrigin)).resolves.toBe("open");
  });

  it("accepts a WebSocket upgrade with no Origin (a non-browser client)", async () => {
    await expect(dialWs(port, sessionId)).resolves.toBe("open");
  });

  it("refuses a WebSocket upgrade from a preview page", async () => {
    // 403 rather than a close code: `onRequest` hooks run for the upgrade
    // request too, so the guard refuses the handshake before the route is
    // reached. The route's own check (`isWebSocketOriginAllowed`) stays as the
    // backstop for a future in which that stops being true.
    await expect(dialWs(port, sessionId, `http://${sessionId}--5173.127.0.0.1.nip.io:${port}`))
      .resolves.toBe(403);
  });

  it("refuses a WebSocket upgrade from an unrelated site", async () => {
    await expect(dialWs(port, sessionId, "https://evil.example")).resolves.toBe(403);
  });

  // -------------------------------------------------------------------------
  // DNS rebinding (planning#378)
  //
  // The attacker's page is served from a name they control which has since
  // re-resolved to this instance. Every request below is genuinely SAME ORIGIN
  // — that is the point — so the whole boundary above passes it. The socket is
  // the same one the real browser would dial; only the `Host` differs.
  // -------------------------------------------------------------------------

  const REBOUND = "rebind.evil.example";

  it("refuses a rebound read", async () => {
    const res = await request(port, "/api/bootstrap", {
      headers: {
        Host: `${REBOUND}:${port}`,
        Origin: `http://${REBOUND}:${port}`,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a rebound write", async () => {
    const res = await request(port, `/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: {
        Host: `${REBOUND}:${port}`,
        Origin: `http://${REBOUND}:${port}`,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a rebound GET that sends no Origin, as a same-origin GET does", async () => {
    const res = await request(port, "/api/bootstrap", {
      headers: { Host: `${REBOUND}:${port}`, "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a rebound GET that sends no browser headers AT ALL", async () => {
    // The one that matters, and the one an earlier draft let through (found in
    // review). A same-origin `GET` omits `Origin`, and Fetch Metadata is
    // appended only for a *potentially trustworthy* URL — which
    // `http://rebind.evil.example` is not, because trustworthiness is judged on
    // the URL's own host string rather than on what it resolves to. So the real
    // browser request has neither marker and looks exactly like the session
    // container's CLI below. The `Host` is the only thing telling them apart.
    const res = await request(port, "/api/bootstrap", {
      headers: { Host: `${REBOUND}:${port}` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a rebound SSE stream", async () => {
    const res = await request(port, "/api/events", {
      headers: {
        Host: `${REBOUND}:${port}`,
        Origin: `http://${REBOUND}:${port}`,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a rebound WebSocket upgrade", async () => {
    await expect(
      dialWs(port, sessionId, `http://${REBOUND}:${port}`, `${REBOUND}:${port}`),
    ).resolves.toBe(403);
  });

  it("keeps a loopback instance reachable at every spelling docs/254 supports", async () => {
    // The regression that would matter most: the fix must not cost the user
    // their own instance. Each of these is a name this very server is
    // legitimately reached at, and none of them is configured anywhere.
    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      `100.83.12.47:${port}`,          // a tailnet address
      `100-83-12-47.sslip.io:${port}`, // the sslip.io preview host
      `shipit.tail1a2b3c.ts.net:${port}`, // MagicDNS
    ]) {
      const res = await request(port, "/api/bootstrap", {
        headers: { Host: host, Origin: `http://${host}`, "Sec-Fetch-Site": "same-origin" },
      });
      expect({ host, status: res.status }).toEqual({ host, status: 200 });
    }
  });

  it("keeps a WebSocket working at a tailnet address and a MagicDNS name", async () => {
    for (const host of [`100.83.12.47:${port}`, `shipit.tail1a2b3c.ts.net:${port}`]) {
      await expect(dialWs(port, sessionId, `http://${host}`, host)).resolves.toBe("open");
    }
  });
});
