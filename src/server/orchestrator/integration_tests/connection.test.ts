import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Connection", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-connection-"));

    const sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it("sends preview_status on connect", async () => {
    const client = await TestClient.connect(port);
    const freshness = await client.receiveType("session_container_freshness");
    expect(freshness).toMatchObject({
      type: "session_container_freshness",
      sessionId: client.sessionId,
      freshness: { state: "unknown" },
    });
    const msg = await client.receiveType("preview_status");

    expect(msg).toMatchObject({
      type: "preview_status",
      running: false,
      port: 5173,
    });

    client.close();
  });

  // docs/311 — the answer a returning client keeps its socket on.
  it("answers a liveness ping with a matching pong", async () => {
    const client = await TestClient.connect(port);

    client.send({ type: "ping", id: "probe-1" });
    const msg = await client.receiveType("pong");

    expect(msg).toMatchObject({ type: "pong", id: "probe-1" });

    client.close();
  });

  // The id is echoed, so it cannot be a client-chosen amount of memory.
  it("bounds the id it echoes back", async () => {
    const client = await TestClient.connect(port);

    client.send({ type: "ping", id: "x".repeat(5000) });
    const msg = await client.receiveType("pong");

    expect((msg as { id: string }).id.length).toBe(64);

    client.close();
  });

  it("returns error for invalid JSON", async () => {
    const client = await TestClient.connect(port);

    client.sendRaw("not valid json {{{");
    const msg = await client.receiveType("error");

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid JSON");

    client.close();
  });
});
