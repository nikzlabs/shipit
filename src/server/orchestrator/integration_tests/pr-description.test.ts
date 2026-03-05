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
} from "./test-helpers.js";

describe("Integration: PR description generation", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess | null;
  let generateTextResult: string;
  let generateTextError: Error | null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-pr-desc-"));
    lastClaude = null;
    generateTextResult = "## Summary\n\nAdded authentication.\n\n## Changes\n\n- Added JWT auth module";
    generateTextError = null;

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => {
        const cp = new FakeClaudeProcess();
        lastClaude = cp;
        return cp as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
      generateText: async () => {
        if (generateTextError) throw generateTextError;
        return generateTextResult;
      },
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  /**
   * Helper: create a session so that git operations work.
   */
  async function createSession(client: TestClient) {
    client.send({ type: "send_message", text: "hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-1",
    });
    claude.finish("agent-1");
    // Drain messages until we're clear
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(200);
        if (msg.type === "git_committed") break;
      } catch {
        break;
      }
    }
  }

  it("generates a PR description with markdown content via HTTP", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createSession(client);
    client.close();

    // Get session ID from bootstrap
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const sessionId = bootstrap.json().sessions[0]?.id;
    expect(sessionId).toBeTruthy();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/description`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.description).toContain("## Summary");
    expect(body.description).toContain("## Changes");
  });

  it("returns description when minimal git history via HTTP", async () => {
    // Build a separate app with an empty git repo (no commits beyond init)
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-pr-empty-"));
    const emptySessionsFile = path.join(emptyDir, "sessions.json");
    let emptyLastClaude: FakeClaudeProcess | null = null;

    const emptyApp = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(emptySessionsFile),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => {
        const cp = new FakeClaudeProcess();
        emptyLastClaude = cp;
        return cp as any;
      },
      workspaceDir: emptyDir,
      serveStatic: false,
      generateText: async () => generateTextResult,
    });

    const emptyAddress = await emptyApp.listen({ port: 0, host: "127.0.0.1" });
    const emptyMatch = /:(\d+)$/.exec(emptyAddress);
    const emptyPort = emptyMatch ? Number(emptyMatch[1]) : 0;

    try {
      const client = await TestClient.connect(emptyPort);
      await client.receive(); // preview_status

      // Create session
      client.send({ type: "send_message", text: "hello" });
      const claude = await waitForClaude(() => emptyLastClaude);
      claude.emit("event", { type: "system", subtype: "init", session_id: "agent-empty" });
      // Don't emit any file changes — finish immediately so git has minimal history
      claude.finish("agent-empty");

      // Drain messages
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          const msg = await client.receive(200);
          if (msg.type === "git_committed") break;
        } catch {
          break;
        }
      }
      client.close();

      // Get session ID and call HTTP endpoint
      const bootstrap = await emptyApp.inject({ method: "GET", url: "/api/bootstrap" });
      const sessionId = bootstrap.json().sessions[0]?.id;
      expect(sessionId).toBeTruthy();

      const res = await emptyApp.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/description`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().description).toBeDefined();
    } finally {
      await emptyApp.close();
      fs.rmSync(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("returns 500 when text generation fails via HTTP", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createSession(client);
    client.close();

    // Get session ID
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const sessionId = bootstrap.json().sessions[0]?.id;

    // Set up the generateText stub to fail
    generateTextError = new Error("Claude process crashed");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/pr/description`,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("Claude process crashed");
  });
});
