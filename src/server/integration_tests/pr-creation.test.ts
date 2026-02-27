import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";

import { ClaudeProcess } from "../claude.js";

import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
} from "./test-helpers.js";

describe("Integration: PR creation — happy path", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let githubAuthManager: StubGitHubAuthManager;
  let lastClaude: FakeClaudeProcess | null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-pr-"));
    lastClaude = null;

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      claudeFactory: () => {
        const cp = new FakeClaudeProcess();
        lastClaude = cp;
        return cp as unknown as ClaudeProcess;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

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
        if (msg.type === "session_started") sessionId = (msg as any).session.id;
        if (msg.type === "git_committed") break;
      } catch {
        break;
      }
    }
    return sessionId;
  }

  it("GET /api/sessions/:id/git/branches returns current branch and remote branches", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await createSession(client);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/git/branches` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.current).toBeDefined();
    expect(Array.isArray(body.remote)).toBe(true);

    client.close();
  });
});
