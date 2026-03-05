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

describe("Integration: PR creation — validation errors", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let githubAuthManager: StubGitHubAuthManager;
  let lastClaude: FakeClaudeProcess | null;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-pr-"));
    lastClaude = null;

    const sessionManager = new SessionManager(dbManager);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => {
        const cp = new FakeClaudeProcess();
        lastClaude = cp;
        return cp as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    dbManager.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  /** Create a session via send_message + Claude events. Returns the app session ID. */
  async function createSession(client: TestClient): Promise<string> {
    client.send({ type: "send_message", text: "hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-1",
    });
    claude.finish("agent-1");

    let sessionId = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(200);
        if (msg.type === "session_started") {
          sessionId = (msg as any).session.id;
        }
        if (msg.type === "git_committed") break;
      } catch {
        break;
      }
    }
    return sessionId;
  }

  async function setupSessionWithRemote(client: TestClient): Promise<string> {
    const sessionId = await createSession(client);

    // Authenticate via HTTP
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    // Set remote via HTTP
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/git/remotes`,
      payload: { name: "origin", url: "https://github.com/test-user/my-project.git" },
    });

    return sessionId;
  }

  it("returns error when not authenticated with GitHub", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await createSession(client);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr`,
      payload: { title: "Some PR", body: "", base: "main" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Not authenticated with GitHub");

    client.close();
  });

  it("returns error when no origin remote is configured", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await createSession(client);

    // Authenticate but don't add a remote
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr`,
      payload: { title: "Some PR", body: "", base: "main" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("No 'origin' remote configured");

    client.close();
  });

  it("returns error when remote is not a GitHub URL", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await createSession(client);

    // Authenticate
    await app.inject({ method: "POST", url: "/api/github/token", payload: { token: "ghp_test" } });

    // Add a non-GitHub remote
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/git/remotes`,
      payload: { name: "origin", url: "https://gitlab.com/user/repo.git" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr`,
      payload: { title: "Some PR", body: "", base: "main" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Remote URL is not a GitHub repository");

    client.close();
  });

  it("returns error when title is empty", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await setupSessionWithRemote(client);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr`,
      payload: { title: "", body: "some body", base: "main" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("PR title is required");

    client.close();
  });

  it("returns error when title is too long", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await setupSessionWithRemote(client);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr`,
      payload: { title: "x".repeat(257), body: "", base: "main" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("PR title too long (max 256 characters)");

    client.close();
  });

  it("returns error when base branch is empty", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await setupSessionWithRemote(client);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr`,
      payload: { title: "Valid Title", body: "", base: "" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Base branch is required");

    client.close();
  });
});
