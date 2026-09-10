import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  waitFor,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { ProviderAccountManager } from "../provider-account-manager.js";
import type { CredentialStore } from "../credential-store.js";

describe("Integration: AskUserQuestion / answer_question flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let allClaudes: FakeClaudeProcess[];
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let credentialsDir: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    allClaudes = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-ask-question-"));
    credentialsDir = path.join(tmpDir, "credentials");

    sessionManager = new SessionManager(dbManager);

    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      credentialStore,
      credentialsDir,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        allClaudes.push(lastClaude);
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
      // Best-effort cleanup.
    }
  });

  it("answer_question kills the stale steering-capable agent and falls through to a fresh --resume spawn when the steering gate fails", async () => {
    // Steering is supported, but disabled in this setup.
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Ask me something" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({ type: "answer_question", toolUseId: "tool-1", answers: { "0": "Redis" } });
    await waitForClaude(() => lastClaude, firstClaude);

    expect(firstClaude.killed).toBe(true);
    expect(firstClaude.stdinData).toEqual([]);
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Redis");

    client.close();
  });

  it("answer_question starts new Claude process when no process is running", async () => {
    sessionManager.track("existing-sess", "Test session");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "First message", sessionId: "existing-sess" });
    await waitForClaude(() => lastClaude);
    const firstClaude = lastClaude;

    firstClaude.finish("existing-sess");
    await new Promise((r) => setTimeout(r, 100));

    client.send({ type: "answer_question", toolUseId: "tool-2", answers: { "0": "PostgreSQL" } });
    await waitForClaude(() => lastClaude, firstClaude);

    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("PostgreSQL");
    expect(lastClaude.lastSessionId).toBe("existing-sess");

    client.close();
  });

  it("answer_question preserves plan mode on the resumed turn (no silent plan-mode exit)", async () => {
    sessionManager.track("plan-sess", "Plan session");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Plan this", sessionId: "plan-sess", permissionMode: "plan" });
    const firstClaude = await waitForClaude(() => lastClaude);
    expect(firstClaude.lastPermissionMode).toBe("plan");

    firstClaude.finish("plan-sess");
    await new Promise((r) => setTimeout(r, 100));

    client.send({
      type: "answer_question",
      toolUseId: "tool-plan",
      answers: { "0": "Frontend" },
      text: "Frontend",
      permissionMode: "plan",
    });
    const resumed = await waitForClaude(() => lastClaude, firstClaude);

    expect(resumed).not.toBe(firstClaude);
    expect(resumed.runCalled).toBe(true);
    expect(resumed.lastPrompt).toBe("Frontend");
    expect(resumed.lastPermissionMode).toBe("plan");

    client.close();
  });

  it("answer_question fall-through emits session_status running=true to viewers", async () => {
    const { sessionId } = await createTestSession(sessionManager, tmpDir, "Ask-test");
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_message", text: "First", sessionId });
    await waitForClaude(() => lastClaude);
    const firstClaude = lastClaude;
    firstClaude.finish(sessionId);

    await new Promise((r) => setTimeout(r, 200));
    // Discard status messages from the first turn.
    while (true) {
      try {
        await client.receive(50);
      } catch {
        break;
      }
    }

    client.send({ type: "answer_question", toolUseId: "tool-2", answers: { "0": "PostgreSQL" } });

    let sawRunning = false;
    const deadline = Date.now() + 2000;
    while (!sawRunning && Date.now() < deadline) {
      let msg;
      try {
        msg = await client.receive(500);
      } catch {
        break;
      }
      if (msg.type === "session_status" && msg.running && msg.sessionId === sessionId) {
        sawRunning = true;
      }
    }
    expect(sawRunning).toBe(true);

    await waitForClaude(() => lastClaude, firstClaude);
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.runCalled).toBe(true);

    client.close();
  });

  it("answer_question returns error for empty answer", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "answer_question", toolUseId: "tool-3", answers: {} });
    const msg = await client.receiveType("error");

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Answer cannot be empty");

    client.close();
  });

  it("answer_question with multiple answers uses the client-formatted text verbatim as the fresh-spawn prompt", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({
      type: "answer_question",
      toolUseId: "tool-4",
      answers: { "0": "Auth", "1": "Cache, with TTL" },
      text: "- Pick a feature?: Auth\n- Cache config?: Cache, with TTL",
    });
    await waitForClaude(() => lastClaude, firstClaude);

    expect(firstClaude.killed).toBe(true);
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.lastPrompt).toBe(
      "- Pick a feature?: Auth\n- Cache config?: Cache, with TTL",
    );

    client.close();
  });

  it("answer_question falls back to joining answers when text is omitted", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({
      type: "answer_question",
      toolUseId: "tool-4b",
      answers: { "0": "Auth", "1": "Cache" },
    });
    await waitForClaude(() => lastClaude, firstClaude);

    expect(firstClaude.killed).toBe(true);
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.lastPrompt).toBe("Auth, Cache");

    client.close();
  });

  it("answer_question steers via sendUserMessage when liveSteering is on and the resident process is streaming (no kill, no respawn)", async () => {
    const credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);

    await app.close();
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        allClaudes.push(lastClaude);
        return lastClaude as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Pick something" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBe(true);

    // Omit `done` to keep the streaming process alive.
    claude.initSession("steer-answer-session");
    claude.emit("event", {
      type: "result",
      subtype: "error",
      session_id: "steer-answer-session",
      duration_ms: 50,
      result: "error_during_execution",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(claude.killed).toBe(false);

    client.send({
      type: "answer_question",
      toolUseId: "ask-1",
      answers: { "0": "Redis" },
      text: "Redis",
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(claude.killed).toBe(false);
    expect(lastClaude).toBe(claude);
    // The fake records sendUserMessage in stdinData; it does not test NDJSON framing.
    expect(claude.stdinData).toContain("Redis");

    client.close();
  });

  it("runs the answered turn's post-turn flow (auto-commit) under live steering — regression for the stale streamingPostTurnFired guard", async () => {
    const credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);

    await app.close();
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        allClaudes.push(lastClaude);
        return lastClaude as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;

    const { sessionId, sessionDir } = await createTestSession(sessionManager, tmpDir, "Steer-commit");
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_message", text: "Pick something", sessionId });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBe(true);
    claude.initSession(sessionId);

    claude.emit("event", {
      type: "result",
      subtype: "error",
      session_id: sessionId,
      duration_ms: 50,
      result: "error_during_execution",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(claude.killed).toBe(false);

    while (true) {
      try {
        await client.receive(50);
      } catch {
        break;
      }
    }

    fs.writeFileSync(path.join(sessionDir, "answer-output.txt"), "from the answered turn");

    client.send({
      type: "answer_question",
      toolUseId: "ask-commit-1",
      answers: { "0": "Redis" },
      text: "Redis",
    });
    await waitFor(() => claude.stdinData.includes("Redis"), "answer delivered to stdin");
    expect(claude.killed).toBe(false);
    expect(lastClaude).toBe(claude);
    expect(claude.stdinData).toContain("Redis");

    claude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      duration_ms: 80,
    });

    let sawCommit = false;
    const deadline = Date.now() + 2000;
    while (!sawCommit && Date.now() < deadline) {
      let msg;
      try {
        msg = await client.receive(500);
      } catch {
        break;
      }
      if (msg.type === "git_committed") sawCommit = true;
    }
    expect(sawCommit).toBe(true);

    client.close();
  });

  it("does not interrupt when AskUserQuestion is emitted with missing/empty questions", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Pick one" });
    await waitForClaude(() => lastClaude);
    expect(lastClaude.interrupted).toBe(false);

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-malformed-1",
          name: "AskUserQuestion",
          input: {},
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastClaude.interrupted).toBe(false);

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-malformed-2",
          name: "AskUserQuestion",
          input: { questions: [] },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastClaude.interrupted).toBe(false);

    client.close();
  });

  it("interrupts the agent when it emits an AskUserQuestion tool_use", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Pick one" });
    await waitForClaude(() => lastClaude);
    expect(lastClaude.interrupted).toBe(false);

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-1",
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: "Pick a backend",
              header: "Backend",
              options: [{ label: "Redis", description: "" }],
              multiSelect: false,
            }],
          },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(lastClaude.interrupted).toBe(true);

    client.close();
  });

  it("suppresses the CLI's auto-resolved tool_result for an interrupted AskUserQuestion", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Pick one" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-suppress-1",
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: "Pick a backend",
              header: "Backend",
              options: [{ label: "Redis", description: "" }],
              multiSelect: false,
            }],
          },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastClaude.interrupted).toBe(true);

    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "ask-suppress-1",
          content: "No user response — auto-resolved by CLI",
        }],
      },
    });

    let sawSuppressedResult = false;
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      let msg;
      try {
        msg = await client.receive(80);
      } catch {
        break;
      }
      if (msg.type === "agent_event") {
        const event = (msg as { event: { type: string; content?: unknown[] } }).event;
        if (event.type === "agent_tool_result") {
          const hasId = (event.content ?? []).some((b) => {
            const id = (b as { tool_use_id?: string }).tool_use_id;
            return id === "ask-suppress-1";
          });
          if (hasId) sawSuppressedResult = true;
        }
      }
    }
    expect(sawSuppressedResult).toBe(false);

    client.close();
  });

  it("survives a tool_result whose content is a bare string while suppression is active", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Pick one" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-string-1",
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: "Pick a backend",
              header: "Backend",
              options: [{ label: "Redis", description: "" }],
              multiSelect: false,
            }],
          },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastClaude.interrupted).toBe(true);

    lastClaude.emit("event", {
      type: "user",
      message: { content: "plain string content" as unknown as unknown[] },
    });

    let sawStringToolResult = false;
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      let msg;
      try {
        msg = await client.receive(80);
      } catch {
        break;
      }
      if (msg.type === "agent_event") {
        const event = (msg as { event: { type: string; content?: unknown } }).event;
        if (event.type === "agent_tool_result" && event.content === "plain string content") {
          sawStringToolResult = true;
        }
      }
    }
    expect(sawStringToolResult).toBe(true);

    // Broadcast precedes extraction: also check that extraction did not strand the turn.
    const strandedClaude = lastClaude;
    client.send({
      type: "answer_question",
      toolUseId: "ask-string-1",
      answers: { "0": "Redis" },
      text: "Redis",
    });

    await waitForClaude(() => lastClaude, strandedClaude);
    expect(lastClaude).not.toBe(strandedClaude);
    expect(lastClaude.lastPrompt).toBe("Redis");

    lastClaude.initSession("string-content-session");
    lastClaude.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "string-content-session",
    });
    lastClaude.emit("done", 0);

    let sawFinished = false;
    const finishDeadline = Date.now() + 500;
    while (Date.now() < finishDeadline) {
      let msg;
      try {
        msg = await client.receive(120);
      } catch {
        break;
      }
      if (msg.type === "session_status" && (msg as { running?: boolean }).running === false) {
        sawFinished = true;
        break;
      }
    }
    expect(sawFinished).toBe(true);

    client.close();
  });
  it("still tries refusal-benched accounts for an answer, failing only after every account actually refuses (docs/260-turn-level-account-routing reqs 6, 9, 12)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Ask me something" });
    const firstClaude = await waitForClaude(() => lastClaude);
    firstClaude.finish(client.sessionId);
    await new Promise((r) => setTimeout(r, 100));

    const accounts = new ProviderAccountManager({ credentialsDir, credentialStore });
    const resetAt = Date.now() + 30 * 60 * 1000;
    for (const label of ["Work", "Personal"]) {
      const acct = accounts.create("anthropic", label);
      accounts.setAccountStatus("anthropic", acct.id, "ready");
      accounts.markAccountExhausted("anthropic", acct.id, resetAt);
    }
    const spawnedBefore = allClaudes.length;

    client.send({ type: "answer_question", toolUseId: "tool-quota", answers: { "0": "Redis" } });

    const attempt1 = await waitForClaude(() => lastClaude, firstClaude);
    expect(attempt1.lastPrompt).toBe("Redis");

    const quotaError = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";
    attempt1.emit("event", { type: "agent_result", error: quotaError, sessionId: "quota-sess" });
    const attempt2 = await waitForClaude(() => lastClaude, attempt1);
    expect(attempt2.lastPrompt).toBe("Redis");

    attempt2.emit("event", { type: "agent_result", error: quotaError, sessionId: "quota-sess" });

    const err = await client.receiveType("error") as unknown as { message: string };
    expect(err.message).toContain("Every connected account refused this turn for quota");
    expect(err.message).toContain("usage limit");
    expect(err.message).toContain("Send this message again");
    expect(allClaudes.slice(spawnedBefore).filter((c) => c.runCalled)).toHaveLength(2);

    client.close();
  });
});
