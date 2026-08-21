/**
 * planning#379 — the anti-framing headers, on a real listening orchestrator
 * built by `buildApp()`.
 *
 * Two things `app.inject()` and the unit tests cannot show:
 *
 *   - that `buildApp()` actually WIRES the guard, rather than that
 *     `framePolicyFor()` returns the right string;
 *   - that `/api/events` carries the headers. That route writes its own header
 *     object straight onto the raw response, so anything set on `reply` never
 *     reaches the wire — the exact shape a review found was silently exempt.
 *     An SSE stream is not framable UI; the point is that the "every response"
 *     contract is literally true, so the next raw-response route does not
 *     inherit an untested exception.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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

function head(port: number, urlPath: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, resolve);
    req.on("error", reject);
    req.end();
  });
}

describe("Integration: the orchestrator refuses to be framed", () => {
  let app: FastifyInstance;
  let dbManager: DatabaseManager;
  let tmpDir: string;
  let port: number;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-frame-guard-"));

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

  it("sends both headers on an ordinary API response", async () => {
    const res = await head(port, "/api/bootstrap");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    res.destroy();
  });

  it("sends them on the raw SSE response too, which bypasses `reply`", async () => {
    const res = await head(port, "/api/events");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    res.destroy();
  });
});
