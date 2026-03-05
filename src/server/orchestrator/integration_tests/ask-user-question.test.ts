import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
} from "./test-helpers.js";

describe("Integration: AskUserQuestion / answer_question flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  /** Most recently created FakeClaudeProcess — set by agentFactory. */
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-ask-question-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("answer_question writes to stdin when Claude process is running", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude message flow
    client.send({ type: "send_message", text: "Ask me something" });
    await waitForClaude(() => lastClaude);

    // Claude is now running — send an answer
    client.send({ type: "answer_question", toolUseId: "tool-1", answers: { "0": "Redis" } });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastClaude.stdinData).toEqual(["Redis\n"]);

    client.close();
  });

  it("answer_question starts new Claude process when no process is running", async () => {
    // Pre-populate a session so we can resume
    sessionManager.track("existing-sess", "Test session");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start and immediately finish a Claude turn to set currentSessionId
    client.send({ type: "send_message", text: "First message", sessionId: "existing-sess" });
    await waitForClaude(() => lastClaude);
    const firstClaude = lastClaude;

    // Simulate Claude finishing
    firstClaude.finish("existing-sess");
    await new Promise((r) => setTimeout(r, 100));

    // Now Claude is null — send an answer
    client.send({ type: "answer_question", toolUseId: "tool-2", answers: { "0": "PostgreSQL" } });
    await new Promise((r) => setTimeout(r, 50));

    // A new ClaudeProcess should have been created
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("PostgreSQL");
    expect(lastClaude.lastSessionId).toBe("existing-sess");

    client.close();
  });

  it("answer_question returns error for empty answer", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "answer_question", toolUseId: "tool-3", answers: {} });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Answer cannot be empty");

    client.close();
  });

  it("answer_question with multiple answers joins them", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude message flow
    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);

    // Send an answer with multiple values
    client.send({
      type: "answer_question",
      toolUseId: "tool-4",
      answers: { "0": "Auth", "1": "Cache" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Should write both answers joined by comma
    expect(lastClaude.stdinData).toEqual(["Auth, Cache\n"]);

    client.close();
  });
});
