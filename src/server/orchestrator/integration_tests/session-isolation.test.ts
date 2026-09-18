import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";

// Stub generatePackageLock to avoid spawning npm in integration tests.
vi.mock("../templates.js", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return { ...mod, generatePackageLock: vi.fn().mockResolvedValue(undefined) };
});
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
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

describe("Integration: Session isolation — creation", () => {
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
      // Ignore cleanup errors.
    }
  });

  it("send_message without sessionId creates an isolated session directory", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Build me an app" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-session-1",
    });

    const sessionMsg = await client.receiveType("session_started");
    const session = (sessionMsg as any).session;
    expect(session.id).toBeTruthy();
    expect(session.title).toBeTruthy();
    expect(session.workspaceDir).toBeTruthy();
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "agent-session-1",
    });
    await client.receiveType("agent_event");
    expect(sessionManager.get(session.id)?.agentSessionId).toBe("agent-session-1");

    expect(fs.existsSync(session.workspaceDir)).toBe(true);
    expect(session.workspaceDir).toContain(path.join(tmpDir, "sessions"));

    client.close();
  });

  it("two sessions get independent workspace directories", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const resA = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "static-html" },
    });
    expect(resA.statusCode).toBe(200);
    const sessionA = resA.json().session;

    const resB = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "react-vite-ts" },
    });
    expect(resB.statusCode).toBe(200);
    const sessionB = resB.json().session;

    expect(sessionA.id).not.toBe(sessionB.id);
    expect(sessionA.workspaceDir).not.toBe(sessionB.workspaceDir);

    expect(fs.existsSync(sessionA.workspaceDir)).toBe(true);
    expect(fs.existsSync(sessionB.workspaceDir)).toBe(true);

    expect(fs.existsSync(path.join(sessionA.workspaceDir, "style.css"))).toBe(true);
    expect(fs.existsSync(path.join(sessionB.workspaceDir, "src/App.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(sessionA.workspaceDir, "src/App.tsx"))).toBe(false);

    client.close();
  });

  it("file_tree shows files from the active session directory", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const templateRes = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "static-html" },
    });
    expect(templateRes.statusCode).toBe(200);
    const session = templateRes.json().session;
    const sessionDir = session.workspaceDir;

    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/files` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const flatNames = body.tree.map((n: any) => n.name);
    expect(flatNames).toContain("index.html");
    expect(flatNames).toContain("style.css");

    expect(fs.existsSync(path.join(sessionDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "index.html"))).toBe(false);

    client.close();
  });

  it("ClaudeProcess.run() receives the session directory as cwd", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastCwd).toBeTruthy();
    expect(lastClaude.lastCwd).toContain(path.join(tmpDir, "sessions"));

    client.close();
  });
});
