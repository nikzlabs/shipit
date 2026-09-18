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
    const msg = await client.receiveType("preview_status");
    expect(msg.type).toBe("preview_status");
    expect((msg as any).running).toBe(false);
    client.close();
  });

  it("two sessions get independent preview state", async () => {
    const clientA = await TestClient.connect(port);
    await clientA.receive();

    clientA.send({ type: "send_message", text: "hello" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();

    try {
      while (true) await clientA.receive(200);
    } catch { /* done */ }

    const clientB = await TestClient.connect(port);
    await clientB.receive();

    clientB.send({ type: "send_message", text: "world" });
    const claude2 = await waitForClaude(() => lastClaude, claude1);
    claude2.finish();

    try {
      while (true) await clientB.receive(200);
    } catch { /* done */ }

    clientA.close();
    clientB.close();
  });

  it("init_preview_config sends a message to Claude", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "hello" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();

    try {
      while (true) await client.receive(200);
    } catch { /* done */ }

    client.send({ type: "init_preview_config" });
    const claude2 = await waitForClaude(() => lastClaude, claude1);

    expect(claude2.runCalled).toBe(true);
    claude2.finish();

    client.close();
  });
});
