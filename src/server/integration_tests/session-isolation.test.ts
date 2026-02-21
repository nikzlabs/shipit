import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Session isolation — creation", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-isolation-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
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

  it("send_message without sessionId creates an isolated session directory", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Build me an app" });
    await waitForClaude(() => lastClaude);

    // Simulate system init
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-session-1",
    });

    // Receive claude_event + session_started
    await client.receiveSkipLogs(); // claude_event
    const sessionMsg = await client.receiveSkipLogs();
    expect(sessionMsg.type).toBe("session_started");

    const session = (sessionMsg as any).session;
    expect(session.id).toBeTruthy();
    expect(session.title).toBe("Build me an app");
    expect(session.workspaceDir).toBeTruthy();
    expect(session.agentSessionId).toBe("agent-session-1");

    // Verify session directory was created on disk
    expect(fs.existsSync(session.workspaceDir)).toBe(true);
    // Session dir should be under tmpDir/sessions/
    expect(session.workspaceDir).toContain(path.join(tmpDir, "sessions"));

    client.close();
  });

  it("two sessions get independent workspace directories", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // --- Session A: create via template using HTTP ---
    const resA = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "static-html" },
    });
    expect(resA.statusCode).toBe(200);
    const sessionA = resA.json().session;

    // --- Session B: create via template using HTTP ---
    const resB = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "react-vite-ts" },
    });
    expect(resB.statusCode).toBe(200);
    const sessionB = resB.json().session;

    // Sessions should have different IDs and directories
    expect(sessionA.id).not.toBe(sessionB.id);
    expect(sessionA.workspaceDir).not.toBe(sessionB.workspaceDir);

    // Both directories should exist
    expect(fs.existsSync(sessionA.workspaceDir)).toBe(true);
    expect(fs.existsSync(sessionB.workspaceDir)).toBe(true);

    // Files are isolated — session A has HTML files, session B has React files
    expect(fs.existsSync(path.join(sessionA.workspaceDir, "style.css"))).toBe(true);
    expect(fs.existsSync(path.join(sessionB.workspaceDir, "src/App.tsx"))).toBe(true);
    // Cross-check: session A should NOT have React files
    expect(fs.existsSync(path.join(sessionA.workspaceDir, "src/App.tsx"))).toBe(false);

    client.close();
  });

  it("file_tree shows files from the active session directory", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create a session via apply_template using HTTP
    const templateRes = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "static-html" },
    });
    expect(templateRes.statusCode).toBe(200);
    const session = templateRes.json().session;
    const sessionDir = session.workspaceDir;

    // Request the file tree via HTTP
    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Should include files from the template in the session directory
    const flatNames = body.tree.map((n: any) => n.name);
    expect(flatNames).toContain("index.html");
    expect(flatNames).toContain("style.css");

    // Files should exist in the session directory, not the root
    expect(fs.existsSync(path.join(sessionDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "index.html"))).toBe(false);

    client.close();
  });

  it("ClaudeProcess.run() receives the session directory as cwd", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    // The claude process should have been called with the session directory as cwd
    expect(lastClaude.lastCwd).toBeTruthy();
    expect(lastClaude.lastCwd).toContain(path.join(tmpDir, "sessions"));

    client.close();
  });
});
