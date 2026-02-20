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

describe("Integration: Session isolation — switching & resume", () => {
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

  it("archive_session preserves the session directory on disk", async () => {
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

    // Archive the session
    client.send({ type: "archive_session", sessionId: session.id });
    const archiveMsg = await client.receive();
    expect(archiveMsg.type).toBe("session_list");

    // Verify directory is still present (archive preserves data)
    expect(fs.existsSync(session.workspaceDir)).toBe(true);

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

    // Switch back to session A — activateSession broadcasts preview_status + clear_logs,
    // then the server sends chat_history, git_log, and file_tree automatically.
    client.send({ type: "get_chat_history", sessionId: sessionA.id });
    const responses: any[] = [];
    // Collect messages until we have chat_history, git_log, and file_tree
    while (!responses.some((m) => m.type === "file_tree")) {
      responses.push(await client.receive());
    }
    expect(responses.some((m) => m.type === "chat_history")).toBe(true);
    expect(responses.some((m) => m.type === "git_log")).toBe(true);

    // File tree (sent by server after activation) should show session A's files
    const treeMsg = responses.find((m) => m.type === "file_tree")!;
    const flatNames = treeMsg.tree.map((n: any) => n.name);
    expect(flatNames).toContain("marker-a.txt");
    expect(flatNames).toContain("index.html");
    // Session B's files should NOT be in the tree
    expect(flatNames).not.toContain("App.tsx");

    client.close();
  });

  it("get_chat_history returns git_log scoped to the activated session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create session A via template and commit a marker file
    client.send({ type: "apply_template", templateId: "static-html" });
    const sessionAMsg = await client.receive(); // session_started
    const sessionA = (sessionAMsg as any).session;
    await client.receive(); // template_applied

    // Add a unique commit in session A
    const gitA = new GitManager(sessionA.workspaceDir);
    fs.writeFileSync(path.join(sessionA.workspaceDir, "a-only.txt"), "session A");
    await gitA.autoCommit("Commit from session A");

    // Create session B
    client.send({ type: "new_session" });
    await client.receive(); // session_list

    client.send({ type: "apply_template", templateId: "react-vite-ts" });
    const sessionBMsg = await client.receive(); // session_started
    const sessionB = (sessionBMsg as any).session;
    await client.receive(); // template_applied

    // Add a unique commit in session B
    const gitB = new GitManager(sessionB.workspaceDir);
    fs.writeFileSync(path.join(sessionB.workspaceDir, "b-only.txt"), "session B");
    await gitB.autoCommit("Commit from session B");

    // Switch to session A — server sends git_log after activation
    client.send({ type: "get_chat_history", sessionId: sessionA.id });
    const responsesA: any[] = [];
    while (!responsesA.some((m) => m.type === "git_log")) {
      responsesA.push(await client.receive());
    }
    const gitLogA = responsesA.find((m) => m.type === "git_log")!;
    const messagesA = gitLogA.commits.map((c: any) => c.message);
    expect(messagesA).toContain("Commit from session A");
    expect(messagesA).not.toContain("Commit from session B");

    // Switch to session B — server sends git_log after activation
    client.send({ type: "get_chat_history", sessionId: sessionB.id });
    const responsesB: any[] = [];
    while (!responsesB.some((m) => m.type === "git_log")) {
      responsesB.push(await client.receive());
    }
    const gitLogB = responsesB.find((m) => m.type === "git_log")!;
    const messagesB = gitLogB.commits.map((c: any) => c.message);
    expect(messagesB).toContain("Commit from session B");
    expect(messagesB).not.toContain("Commit from session A");

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

  it("auto-commit goes to the correct session when user switches mid-turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start session A — send a message to trigger agent
    client.send({ type: "send_message", text: "Session A work" });
    const claudeA = await waitForClaude(() => lastClaude);

    // Simulate agent init (ClaudeEvent format — adapter translates to AgentEvent)
    claudeA.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-session-a",
      model: "claude-sonnet-4-20250514",
    });

    // Wait for session_started so we know session A is created
    const sessionAMsg = await client.receiveType("session_started");
    const sessionA = (sessionAMsg as any).session;

    // Write a file in session A's workspace (simulates agent writing code)
    fs.writeFileSync(path.join(sessionA.workspaceDir, "from-agent-a.txt"), "session A output");

    // Now create session B while agent A is still running
    client.send({ type: "new_session" });
    await client.receiveType("session_list");

    // Apply a template to create session B with its own workspace
    client.send({ type: "apply_template", templateId: "static-html" });
    const sessionBMsg = await client.receiveType("session_started");
    const sessionB = (sessionBMsg as any).session;
    await client.receiveType("template_applied");

    // Verify sessions are different directories
    expect(sessionA.workspaceDir).not.toBe(sessionB.workspaceDir);

    // Now agent A finishes — the auto-commit should go to session A's repo, NOT session B's.
    // After new_session, we detached from session A's runner, so git_committed won't
    // reach this client. Instead verify via git log directly.
    claudeA.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "agent-session-a",
    });
    claudeA.emit("done", 0);

    // Wait for the async done handler to complete (auto-commit is async)
    await new Promise((r) => setTimeout(r, 500));

    // Verify: session A should have the agent's commit
    const gitA = new GitManager(sessionA.workspaceDir);
    const logA = await gitA.log();
    // Should have "Initial commit" + the auto-commit from agent done
    expect(logA.length).toBeGreaterThanOrEqual(2);
    expect(logA.some((c) => c.message === "Agent turn")).toBe(true);

    // Verify: session B should NOT have the agent's commit (only template commits)
    const gitB = new GitManager(sessionB.workspaceDir);
    const logB = await gitB.log();
    const logBMessages = logB.map((c) => c.message);
    expect(logBMessages.every((m) => m !== "Agent turn")).toBe(true);

    // Session B should only have template-related commits
    expect(logBMessages.some((m) => m.includes("Apply template"))).toBe(true);

    client.close();
  });
});
