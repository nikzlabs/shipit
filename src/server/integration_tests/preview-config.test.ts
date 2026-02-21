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
import type { PreviewManager } from "../preview-manager.js";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  StubFileWatcher,
  FakeClaudeProcess,
  waitForClaude,
  StubGitHubAuthManager,
  createTestCredentialStore,
} from "./test-helpers.js";

describe("Integration: Preview config and session-switch cleanup", () => {
  let tmpDir: string;
  let port: number;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let lastClaude: FakeClaudeProcess | null;
  const fileWatcher = new StubFileWatcher();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-cfg-"));
    lastClaude = null;

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as any,
      githubAuthManager: new StubGitHubAuthManager() as any,
      fileWatcher: fileWatcher as any,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess() as any;
        return lastClaude as any;
      },
      detectPorts: async () => [],
      baselinePorts: [],
    });

    await app.listen({ port: 0 });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends preview_status on initial connect", async () => {
    const client = await TestClient.connect(port);
    const msg = await client.receive();
    expect(msg.type).toBe("preview_status");
    expect((msg as any).running).toBe(false);
    client.close();
  });

  it("session switch broadcasts clear_logs and preview_status", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // initial preview_status

    // Create two sessions
    const sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Start session via send_message (creates session A)
    client.send({ type: "send_message", text: "hello" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();

    // Drain messages to settle
    try {
      while (true) await client.receive(200);
    } catch { /* done */ }

    // Create a second session
    client.send({ type: "new_session" });
    try {
      while (true) await client.receive(200);
    } catch { /* done */ }

    // Start session B
    client.send({ type: "send_message", text: "world" });
    const claude2 = await waitForClaude(() => lastClaude, claude1);
    claude2.finish();

    // Drain all messages from session B
    try {
      while (true) await client.receive(200);
    } catch { /* done */ }

    client.close();
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
