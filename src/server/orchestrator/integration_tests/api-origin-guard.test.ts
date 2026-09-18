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

function dialWs(
  port: number,
  sessionId: string,
  origin?: string,
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
    // A refused upgrade returns an HTTP status before the WebSocket opens.
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
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
    const res = await request(port, "/%61pi/bootstrap", {
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("sessions");
  });

  it("still lets an OAuth provider redirect the browser onto the MCP callback", async () => {
    const res = await request(port, "/api/mcp-servers/oauth/callback?code=C&state=nope", {
      headers: {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
    });
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
    await expect(dialWs(port, sessionId, `http://${sessionId}--5173.127.0.0.1.nip.io:${port}`))
      .resolves.toBe(403);
  });

  it("refuses a WebSocket upgrade from an unrelated site", async () => {
    await expect(dialWs(port, sessionId, "https://evil.example")).resolves.toBe(403);
  });

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
    // An untrusted HTTP origin can omit both Origin and Fetch Metadata headers.
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
    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      `100.83.12.47:${port}`,
      `100-83-12-47.sslip.io:${port}`,
      `shipit.tail1a2b3c.ts.net:${port}`,
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
