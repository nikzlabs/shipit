import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
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
} from "./test-helpers.js";

describe("Integration: Session management", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-session-mgmt-"));

    const gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      gitManager,
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
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
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("list_sessions returns empty list initially", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_sessions" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");
    expect((msg as any).sessions).toEqual([]);

    client.close();
  });

  it("new_session returns session list", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "new_session" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");

    client.close();
  });

  it("delete_session removes a session", async () => {
    // Pre-populate a session
    sessionManager.track("sess-1", "Test session");

    const client = await TestClient.connect(port);
    await client.receive();

    // Verify it exists
    client.send({ type: "list_sessions" });
    const listMsg = await client.receive();
    expect((listMsg as any).sessions).toHaveLength(1);

    // Delete it
    client.send({ type: "delete_session", sessionId: "sess-1" });
    const deleteMsg = await client.receive();
    expect(deleteMsg.type).toBe("session_list");
    expect((deleteMsg as any).sessions).toHaveLength(0);

    client.close();
  });

  it("rename_session renames a session and returns updated session", async () => {
    sessionManager.track("sess-1", "Original title");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "sess-1", title: "New title" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_renamed");
    expect((msg as any).session.id).toBe("sess-1");
    expect((msg as any).session.title).toBe("New title");

    // Verify the session was actually renamed in the manager
    const sessions = sessionManager.list();
    expect(sessions[0].title).toBe("New title");

    client.close();
  });

  it("rename_session returns error for non-existent session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "nonexistent", title: "Nope" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Session not found");

    client.close();
  });

  it("rename_session rejects empty title", async () => {
    sessionManager.track("sess-1", "Original title");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "sess-1", title: "   " });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Session title cannot be empty");

    // Verify the title was NOT changed
    expect(sessionManager.list()[0].title).toBe("Original title");

    client.close();
  });
});
