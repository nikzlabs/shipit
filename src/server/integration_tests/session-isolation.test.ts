import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Session isolation", () => {
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
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
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

    // --- Session A: create via template (simpler than send_message + system.init) ---
    client.send({ type: "apply_template", templateId: "static-html" });
    const sessionAMsg = await client.receive(); // session_started
    expect(sessionAMsg.type).toBe("session_started");
    const sessionA = (sessionAMsg as any).session;
    await client.receive(); // template_applied

    // --- Session B: start a new session ---
    client.send({ type: "new_session" });
    await client.receive(); // session_list

    client.send({ type: "apply_template", templateId: "react-vite-ts" });
    const sessionBMsg = await client.receive(); // session_started
    expect(sessionBMsg.type).toBe("session_started");
    const sessionB = (sessionBMsg as any).session;
    await client.receive(); // template_applied

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

    // Create a session via apply_template
    client.send({ type: "apply_template", templateId: "static-html" });
    const sessionMsg = await client.receive();
    expect(sessionMsg.type).toBe("session_started");
    const sessionDir = (sessionMsg as any).session.workspaceDir;
    await client.receive(); // template_applied

    // Request the file tree
    client.send({ type: "get_file_tree" });
    const treeMsg = await client.receive();
    expect(treeMsg.type).toBe("file_tree");

    // Should include files from the template in the session directory
    const flatNames = (treeMsg as any).tree.map((n: any) => n.name);
    expect(flatNames).toContain("index.html");
    expect(flatNames).toContain("style.css");

    // Files should exist in the session directory, not the root
    expect(fs.existsSync(path.join(sessionDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "index.html"))).toBe(false);

    client.close();
  });

  it("delete_session removes the session directory from disk", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create a session via template
    client.send({ type: "apply_template", templateId: "static-html" });
    const sessionMsg = await client.receive();
    expect(sessionMsg.type).toBe("session_started");
    const session = (sessionMsg as any).session;
    await client.receive(); // template_applied

    // Verify directory exists
    expect(fs.existsSync(session.workspaceDir)).toBe(true);

    // Delete the session
    client.send({ type: "delete_session", sessionId: session.id });
    const deleteMsg = await client.receive();
    expect(deleteMsg.type).toBe("session_list");

    // Verify directory was removed
    expect(fs.existsSync(session.workspaceDir)).toBe(false);

    client.close();
  });

  it("session switch via get_chat_history changes active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create session A via template
    client.send({ type: "apply_template", templateId: "static-html" });
    const sessionAMsg = await client.receive(); // session_started
    const sessionA = (sessionAMsg as any).session;
    await client.receive(); // template_applied

    // Write a marker file in session A's directory
    fs.writeFileSync(path.join(sessionA.workspaceDir, "marker-a.txt"), "session A");

    // Start new session
    client.send({ type: "new_session" });
    await client.receive(); // session_list

    // Create session B
    client.send({ type: "apply_template", templateId: "react-vite-ts" });
    const sessionBMsg = await client.receive(); // session_started
    expect(sessionBMsg.type).toBe("session_started");
    await client.receive(); // template_applied

    // Switch back to session A
    client.send({ type: "get_chat_history", sessionId: sessionA.id });
    const historyMsg = await client.receive();
    expect(historyMsg.type).toBe("chat_history");

    // File tree should now show session A's files
    client.send({ type: "get_file_tree" });
    const treeMsg = await client.receive();
    expect(treeMsg.type).toBe("file_tree");
    const flatNames = (treeMsg as any).tree.map((n: any) => n.name);
    expect(flatNames).toContain("marker-a.txt");
    expect(flatNames).toContain("index.html");
    // Session B's files should NOT be in the tree
    expect(flatNames).not.toContain("App.tsx");

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

  it("resumed session passes agent session ID to ClaudeProcess.run()", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create a session
    client.send({ type: "send_message", text: "First turn" });
    await waitForClaude(() => lastClaude);
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "my-agent-session" });
    await client.receiveSkipLogs(); // claude_event
    const sessionMsg = await client.receiveSkipLogs();
    const appSessionId = (sessionMsg as any).session.id;
    lastClaude.emit("done", 0);
    await new Promise((r) => setTimeout(r, 100));

    // Resume the session — wait for NEW Claude instance
    const prevClaude2 = lastClaude;
    client.send({ type: "send_message", text: "Second turn", sessionId: appSessionId });
    await waitForClaude(() => lastClaude, prevClaude2);

    // The resumed session should pass the agent session ID for --resume
    expect(lastClaude.lastSessionId).toBe("my-agent-session");

    client.close();
  });
});
