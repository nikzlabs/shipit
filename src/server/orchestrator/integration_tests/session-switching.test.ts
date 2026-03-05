import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Session isolation — switching & resume", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-isolation-"));

    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as any;
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
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("archive_session preserves the session directory on disk", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create a session via template using HTTP
    const templateRes = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "static-html" },
    });
    expect(templateRes.statusCode).toBe(200);
    const session = templateRes.json().session;

    // Verify directory exists
    expect(fs.existsSync(session.workspaceDir)).toBe(true);

    // Archive the session via HTTP
    const archiveRes = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}`,
    });
    expect(archiveRes.statusCode).toBe(200);

    // Verify directory is still present (archive preserves data)
    expect(fs.existsSync(session.workspaceDir)).toBe(true);

    client.close();
  });

  it("session switch via HTTP history returns correct file tree", async () => {
    // Create session A via template using HTTP
    const resA = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "static-html" },
    });
    expect(resA.statusCode).toBe(200);
    const sessionA = resA.json().session;

    // Write a marker file in session A's directory
    fs.writeFileSync(path.join(sessionA.workspaceDir, "marker-a.txt"), "session A");

    // Create session B via template using HTTP
    await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "react-vite-ts" },
    });

    // Fetch session A's history via HTTP — should show session A's files
    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${sessionA.id}/history` });
    expect(historyRes.statusCode).toBe(200);
    const body = historyRes.json();

    expect(body.messages).toBeDefined();
    expect(body.commits).toBeDefined();
    expect(body.fileTree).toBeDefined();

    const flatNames = body.fileTree.map((n: any) => n.name);
    expect(flatNames).toContain("marker-a.txt");
    expect(flatNames).toContain("index.html");
    // Session B's files should NOT be in the tree
    expect(flatNames).not.toContain("App.tsx");
  });

  it("HTTP history returns git_log scoped to each session", async () => {
    // Create session A via template using HTTP
    const resA = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "static-html" },
    });
    expect(resA.statusCode).toBe(200);
    const sessionA = resA.json().session;

    // Add a unique commit in session A
    const gitA = new GitManager(sessionA.workspaceDir);
    fs.writeFileSync(path.join(sessionA.workspaceDir, "a-only.txt"), "session A");
    await gitA.autoCommit("Commit from session A");

    // Create session B via template using HTTP
    const resB = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "react-vite-ts" },
    });
    expect(resB.statusCode).toBe(200);
    const sessionB = resB.json().session;

    // Add a unique commit in session B
    const gitB = new GitManager(sessionB.workspaceDir);
    fs.writeFileSync(path.join(sessionB.workspaceDir, "b-only.txt"), "session B");
    await gitB.autoCommit("Commit from session B");

    // Fetch session A's history — git log scoped to session A
    const historyA = await app.inject({ method: "GET", url: `/api/sessions/${sessionA.id}/history` });
    const messagesA = historyA.json().commits.map((c: any) => c.message);
    expect(messagesA).toContain("Commit from session A");
    expect(messagesA).not.toContain("Commit from session B");

    // Fetch session B's history — git log scoped to session B
    const historyB = await app.inject({ method: "GET", url: `/api/sessions/${sessionB.id}/history` });
    const messagesB = historyB.json().commits.map((c: any) => c.message);
    expect(messagesB).toContain("Commit from session B");
    expect(messagesB).not.toContain("Commit from session A");
  });

  it("resumed session passes agent session ID to ClaudeProcess.run()", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create a session
    client.send({ type: "send_message", text: "First turn" });
    await waitForClaude(() => lastClaude);
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "my-agent-session" });
    const sessionMsg = await client.receiveType("session_started");
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

    // Now create session B while agent A is still running (via HTTP)
    const resBTemplate = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "static-html" },
    });
    expect(resBTemplate.statusCode).toBe(200);
    const sessionB = resBTemplate.json().session;

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
