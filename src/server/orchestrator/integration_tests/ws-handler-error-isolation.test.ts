/**
 * Integration test: a WS handler that throws/rejects MUST NOT crash the
 * orchestrator.
 *
 * Production incident (docs/142): a `POST /terminal/start` call to a wedged
 * session worker timed out with a WorkerTimeoutError. The WS dispatcher used
 * `return handler(ctx, msg)` — so the rejection floated out of the async
 * `socket.on("message")` callback as an unhandled rejection, and Node's
 * default behavior took down the entire orchestrator (every live session with
 * it). The dispatcher now `await`s each handler inside a try/catch and degrades
 * to a per-session `error` message.
 *
 * This is the executable contract for that fix: drive a handler to reject and
 * assert the client gets an `error` (not a dead process). Under the old
 * dispatcher this same scenario surfaced as an unhandled rejection — which the
 * test runner reports as a failure — so the test genuinely distinguishes the
 * two behaviors.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

// Test assertions inspect heterogeneous ws messages at runtime.
type AnyMsg = any;

describe("Integration: WS handler error isolation", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let dbManager: DatabaseManager;
  // When set, the agent factory throws to simulate a handler-level failure
  // (e.g. the worker HTTP timeout from the incident).
  let throwOnAgentCreate = false;

  beforeEach(async () => {
    throwOnAgentCreate = false;
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-ws-err-iso-"));
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        if (throwOnAgentCreate) throw new Error("simulated worker timeout");
        return new FakeClaudeProcess() as never;
      },
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
    } catch { /* ignore cleanup errors */ }
  });

  async function drainUntil(client: TestClient, pred: (m: AnyMsg) => boolean, maxMsgs = 50): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const m: AnyMsg = await client.receive(3000);
      if (pred(m)) return m;
    }
    return null;
  }

  it("a rejecting handler surfaces a client error instead of crashing the orchestrator", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    throwOnAgentCreate = true;
    client.send({ type: "send_message", text: "boom" });

    // The dispatcher's try/catch converts the rejection into a client-visible
    // error. Under the old `return handler(...)` dispatcher this floated out as
    // an unhandled rejection (process death) and no error reached the client.
    const err = await drainUntil(client, (m) => m.type === "error");
    expect(err).toBeTruthy();
    expect(typeof err.message).toBe("string");

    // The orchestrator is still up and the connection was not torn down:
    // receiving the error at all proves the dispatcher caught the rejection
    // rather than letting it crash the process. WebSocket.OPEN === 1.
    expect(client.readyState).toBe(1);
  });
});
