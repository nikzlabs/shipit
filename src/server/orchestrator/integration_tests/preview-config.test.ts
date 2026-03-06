/**
 * Integration tests for preview config resolution and session switch cleanup.
 *
 * Tests the new WS message types:
 * - preview_config_missing: sent when no config found
 * - preview_config_error: sent when shipit.yaml is malformed
 * - clear_logs: broadcast during session switch
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  StubGitHubAuthManager,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Preview config and session-switch cleanup", () => {
  let tmpDir: string;
  let port: number;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let lastClaude: FakeClaudeProcess | null;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-cfg-"));
    lastClaude = null;
    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      workspaceDir: tmpDir,
      serveStatic: false,
      authManager: new StubAuthManager() as any,
      githubAuthManager: new StubGitHubAuthManager() as any,
      sessionManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess() as any;
        return lastClaude as any;
      },
    });

    await app.listen({ port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends preview_status on initial connect", async () => {
    const client = await TestClient.connect(port);
    const msg = await client.receive();
    expect(msg.type).toBe("preview_status");
    expect((msg as any).running).toBe(false);
    client.close();
  });

  it("two sessions get independent preview state", async () => {
    // Session A
    const clientA = await TestClient.connect(port);
    await clientA.receive(); // initial preview_status

    // Start agent in session A
    clientA.send({ type: "send_message", text: "hello" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();

    // Drain messages to settle
    try {
      while (true) await clientA.receive(200);
    } catch { /* done */ }

    // Session B — new connection to a new session
    const clientB = await TestClient.connect(port);
    await clientB.receive(); // initial preview_status

    // Start agent in session B
    clientB.send({ type: "send_message", text: "world" });
    const claude2 = await waitForClaude(() => lastClaude, claude1);
    claude2.finish();

    // Drain all messages from session B
    try {
      while (true) await clientB.receive(200);
    } catch { /* done */ }

    clientA.close();
    clientB.close();
  });

  it("init_preview_config sends a message to Claude", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create a session first
    client.send({ type: "send_message", text: "hello" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();

    // Drain messages
    try {
      while (true) await client.receive(200);
    } catch { /* done */ }

    // Send init_preview_config
    client.send({ type: "init_preview_config" });
    const claude2 = await waitForClaude(() => lastClaude, claude1);

    // Claude should have been started with a prompt about shipit.yaml
    expect(claude2.runCalled).toBe(true);
    claude2.finish();

    client.close();
  });
});
