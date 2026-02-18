import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Permission modes", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-perm-modes-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, "chat-history"));

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("auto mode (default) passes no permissionMode to ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastPrompt).toBe("Hello");
    expect(lastClaude.lastPermissionMode).toBeUndefined();

    client.close();
  });

  it("plan mode passes permissionMode 'plan' to ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Analyze the codebase", permissionMode: "plan" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastPrompt).toBe("Analyze the codebase");
    expect(lastClaude.lastPermissionMode).toBe("plan");

    client.close();
  });

  it("normal mode passes permissionMode 'normal' to ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Make careful changes", permissionMode: "normal" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastPrompt).toBe("Make careful changes");
    expect(lastClaude.lastPermissionMode).toBe("normal");

    client.close();
  });

  it("switching mode mid-session changes ClaudeProcess args", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First message in plan mode
    client.send({ type: "send_message", text: "Plan first", permissionMode: "plan" });
    await waitForClaude(() => lastClaude);
    const planClaude = lastClaude;

    expect(planClaude.lastPermissionMode).toBe("plan");

    // Emit init + result to complete the first turn
    planClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "mode-switch-session",
    });
    planClaude.finish("mode-switch-session");

    // Drain messages
    const drainTimeout = Date.now() + 2000;
    while (Date.now() < drainTimeout) {
      try {
        await client.receive(100);
      } catch {
        break;
      }
    }

    // Second message in auto mode (no permissionMode field)
    const sessionId = sessionManager.list()[0]?.id;
    client.send({ type: "send_message", text: "Execute the plan", sessionId });
    await waitForClaude(() => lastClaude, planClaude);

    expect(lastClaude.lastPrompt).toBe("Execute the plan");
    expect(lastClaude.lastPermissionMode).toBeUndefined();

    client.close();
  });
});
