/**
 * Integration tests for the Codex agent adapter.
 *
 * Tests the agent selection and message flow through the server, verifying
 * that agent switching works correctly and agent_event messages are
 * properly relayed to clients.
 *
 * Agent selection now uses defaultAgentId in buildApp (was previously
 * a per-connection WS set_agent message). Validation uses HTTP
 * POST /api/settings/agent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import type { FastifyInstance } from "fastify";
import type { WsServerMessage } from "../../shared/types.js";
import type {
  AgentProcess,
  AgentProcessEvents,
  AgentCapabilities,
  AgentId,
  AgentRunParams,
} from "../../shared/types.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

/**
 * FakeCodexProcess simulates the CodexAdapter for integration tests.
 * The test controls it by emitting events, just like FakeClaudeProcess.
 */
class FakeCodexProcess extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "codex";
  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: false,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: ["shell", "file_write", "file_read", "file_edit"],
    models: ["codex-mini-latest", "o4-mini"],
    supportsReview: false,
    supportsSteering: false,
    skillsDirName: ".codex",
    skillInvocationPrefix: "$",
  };

  public runCalled = false;
  public lastParams: AgentRunParams | null = null;
  public killed = false;

  readonly isStreaming = false;

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }

  writeStdin(_data: string): void {
    // no-op for tests
  }

  sendUserMessage(_text: string): void {
    // no-op for tests
  }

  interrupt(): void {
    this.kill();
  }

  kill(): void {
    this.killed = true;
  }

  /** Helper: simulate a complete Codex turn. */
  finish(threadId = "codex-thread-001", code = 0) {
    this.emit("event", { type: "agent_result", status: "success", sessionId: threadId });
    this.emit("done", code);
  }
}

/** Wait for a FakeCodexProcess to be started. */
async function waitForCodex(
  getCodex: () => FakeCodexProcess | null,
  notInstance?: FakeCodexProcess | null,
  timeoutMs = 5000,
): Promise<FakeCodexProcess> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const c = getCodex();
    if (c?.runCalled && c !== notInstance) return c;
    if (Date.now() > deadline) throw new Error("Timed out waiting for CodexProcess.run()");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Receive the next message of a specific type, skipping others.
 * Useful when the server sends multiple message types (agent_event,
 * log_entry, model_info, session_started, etc.).
 */
async function receiveByType(
  client: TestClient,
  type: string,
  timeoutMs = 3000,
): Promise<WsServerMessage> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`receiveByType("${type}") timed out`);
    const msg = await client.receive(remaining);
    if (msg.type === type) return msg;
  }
}

/** Shared agent factory builder for codex tests. */
function makeAgentFactory(
  _getLastClaude: () => FakeClaudeProcess,
  setLastClaude: (c: FakeClaudeProcess) => void,
  _getLastCodex: () => FakeCodexProcess,
  setLastCodex: (c: FakeCodexProcess) => void,
) {
  return (agentId: AgentId) => {
    if (agentId === "codex") {
      const codex = new FakeCodexProcess();
      setLastCodex(codex);
      return codex;
    }
    const claude = new FakeClaudeProcess();
    setLastClaude(claude);
    return claude as any;
  };
}

/** Build an agent registry with codex detected and auth-configured. */
async function makeRegistry(): Promise<AgentRegistry> {
  const registry = new AgentRegistry({
    checkBinary: async (binary) => binary === "claude" || binary === "codex",
    checkClaudeAuth: () => true,
  });
  await registry.detect();
  process.env.OPENAI_API_KEY = "test-key-for-codex";
  registry.refreshAuth("codex");
  return registry;
}

describe("Integration: Codex agent — defaultAgentId=codex message flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as any;
  let lastCodex: FakeCodexProcess = null as any;
  let savedOpenAIKey: string | undefined;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    lastCodex = null as any;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-codex-agent-"));

    const sessionManager = new SessionManager(dbManager);
    const chatHistoryManager = new ChatHistoryManager(dbManager);
    const registry = await makeRegistry();

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      agentFactory: makeAgentFactory(
        () => lastClaude, (c) => { lastClaude = c; },
        () => lastCodex, (c) => { lastCodex = c; },
      ),
      defaultAgentId: "codex" as AgentId,
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
    if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("defaultAgentId=codex uses Codex adapter for send_message", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send a message — should use Codex adapter (defaultAgentId is "codex")
    client.send({ type: "send_message", text: "Hello Codex" });

    const codex = await waitForCodex(() => lastCodex);
    expect(codex.runCalled).toBe(true);
    expect(codex.lastParams?.prompt).toBe("Hello Codex");

    // Claude should NOT have been used
    expect(lastClaude).toBeNull();

    client.close();
  });

  it("model param wins over a stale agent param for an unpinned session (docs/142 C)", async () => {
    // defaultAgentId is codex. The client sends the user's real model (Opus,
    // Claude-only) alongside a stale agent=codex param. The model is the single
    // source of truth, so the unpinned session must derive Claude and run it —
    // this is the server-side guard against the Opus→gpt-5.5 silent switch.
    const client = await TestClient.connect(port, undefined, { model: "opus", agent: "codex" });
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });

    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);
    // Codex (the default + the stale param) must NOT have run.
    expect(lastCodex).toBeNull();

    client.close();
  });

  it("set_model with another agent's model self-heals by switching agent (Codex → Opus)", async () => {
    // Repro: new session defaults to Codex; user picks Opus from the grouped
    // model picker. The picker fires set_agent THEN set_model, but if set_agent
    // is dropped/raced, set_model used to reject ("Model \"opus\" is not
    // available for Codex") and the model stayed locked to gpt-5.5. The
    // handler now switches to the agent that owns the model.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send ONLY set_model — deliberately omit set_agent to prove self-healing.
    client.send({ type: "set_model", model: "opus" });
    await new Promise((r) => setTimeout(r, 50));

    // A subsequent message must run on Claude (the owner of "opus"), not Codex.
    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);
    expect(lastCodex).toBeNull();

    client.close();
  });

  it("set_model rejects a model no installed+authed agent supports", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_model", model: "totally-made-up-model" });

    const err = await receiveByType(client, "error");
    expect((err as any).message).toContain("is not available");

    client.close();
  });

  it("Codex agent_event messages are relayed to the client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Write hello world" });

    const codex = await waitForCodex(() => lastCodex);

    // Simulate Codex emitting an agent_init event
    codex.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: "codex-thread-001",
      model: "codex-mini-latest",
      tools: ["shell", "file_write"],
    });

    // Client should receive the agent_event (skip log_entry etc.)
    const agentEventMsg = await receiveByType(client, "agent_event");
    expect((agentEventMsg as any).event.type).toBe("agent_init");
    expect((agentEventMsg as any).event.agentId).toBe("codex");
    expect((agentEventMsg as any).event.sessionId).toBe("codex-thread-001");

    client.close();
  });

  it("Codex assistant events are relayed as agent_event", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });

    const codex = await waitForCodex(() => lastCodex);

    // Init first to establish session
    codex.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: "codex-thread-001",
      model: "codex-mini-latest",
    });

    // Wait for session_started
    await receiveByType(client, "session_started");

    // Now emit an assistant event with text content
    codex.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "I can help with that!" }],
    });

    // Find the agent_event with assistant content
    const assistantEvent = await receiveByType(client, "agent_event");
    expect((assistantEvent as any).event.type).toBe("agent_assistant");
    expect((assistantEvent as any).event.content[0].text).toBe("I can help with that!");

    client.close();
  });

  it("Codex tool_use events are relayed as agent_event", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Run ls" });

    const codex = await waitForCodex(() => lastCodex);

    // Init to establish session
    codex.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: "codex-thread-002",
    });
    await receiveByType(client, "session_started");

    // Emit a tool_use event
    codex.emit("event", {
      type: "agent_assistant",
      content: [{
        type: "tool_use",
        id: "call-001",
        name: "shell",
        input: { command: "ls -la" },
      }],
    });

    // Find the agent_event with tool_use
    const toolEvent = await receiveByType(client, "agent_event");
    expect((toolEvent as any).event.type).toBe("agent_assistant");
    expect((toolEvent as any).event.content[0].type).toBe("tool_use");
    expect((toolEvent as any).event.content[0].name).toBe("shell");
    expect((toolEvent as any).event.content[0].input.command).toBe("ls -la");

    client.close();
  });

  it("Codex agent_result event completes the turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Done?" });

    const codex = await waitForCodex(() => lastCodex);

    // Init
    codex.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: "codex-thread-003",
    });
    await receiveByType(client, "session_started");

    // Finish the turn
    codex.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "codex-thread-003",
      tokens: { input: 100, output: 50 },
    });
    codex.emit("done", 0);

    // Find agent_result event
    const resultEvent = await receiveByType(client, "agent_event");
    expect((resultEvent as any).event.type).toBe("agent_result");
    expect((resultEvent as any).event.status).toBe("success");

    client.close();
  });

  it("Codex error event is relayed to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Fail" });

    const codex = await waitForCodex(() => lastCodex);

    codex.emit("error", new Error("codex app-server crashed"));

    const msg = await receiveByType(client, "error");
    expect((msg as any).message).toContain("Agent process error");
    expect((msg as any).message).toContain("codex app-server crashed");

    client.close();
  });
});

describe("Integration: Codex agent — validation and default agent", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as any;
  let lastCodex: FakeCodexProcess = null as any;
  let savedOpenAIKey: string | undefined;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    lastCodex = null as any;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-codex-default-"));

    sessionManager = new SessionManager(dbManager);
    const chatHistoryManager = new ChatHistoryManager(dbManager);
    const registry = await makeRegistry();

    // Default agent is "claude" — tests that need the default behavior
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      agentFactory: makeAgentFactory(
        () => lastClaude, (c) => { lastClaude = c; },
        () => lastCodex, (c) => { lastCodex = c; },
      ),
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
    if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("set_agent validates agent via HTTP and rejects invalid agentId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/agent",
      payload: { agentId: "invalid-agent" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Unknown agent");
  });

  it("set_agent validates agent via HTTP and accepts valid agentId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/agent",
      payload: { agentId: "codex" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agentId).toBe("codex");
  });

  it("activation adopts the session's persisted agent over a pre-seeded runner", async () => {
    // Repro for "issue with the selected model (gpt-5.5)": a runner is seeded
    // with the global default agent (claude) at creation (warm pool / recovery),
    // but the session committed agent_id=codex (+ model gpt-5.5). If activation
    // doesn't reconcile the runner to the session's agent, getActiveAgentId()
    // returns claude and the turn spawns `claude --model gpt-5.5`.
    const created = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "codex session" },
    });
    const sessionId = created.json().sessionId as string;

    // Session committed to codex + a codex model.
    sessionManager.setAgentId(sessionId, "codex" as AgentId);
    sessionManager.setModel(sessionId, "gpt-5.5");

    // Pre-seed a runner as claude (the global default) — mimics the warm pool.
    await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      payload: { running: false },
    });

    // Connect and send — must run on Codex, the session's committed agent.
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status
    client.send({ type: "send_message", text: "what model are you?" });

    const codex = await waitForCodex(() => lastCodex);
    expect(codex.runCalled).toBe(true);
    expect(lastClaude).toBeNull();

    client.close();
  });

  it("default agent is claude when defaultAgentId is not set", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send message — should use Claude (default)
    client.send({ type: "send_message", text: "Hello Claude" });

    await waitForClaude(() => lastClaude);
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Hello Claude");
    expect(lastCodex).toBeNull();

    client.close();
  });

  it("docs/138: set_agent is rejected once the session is pinned (first turn)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First turn pins the agent (claude, the default) for this session.
    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);
    expect(lastClaude.runCalled).toBe(true);

    // Switching to a different agent is now rejected with a "locked" error.
    client.send({ type: "set_agent", agentId: "codex" });
    const err = await receiveByType(client, "error");
    expect((err as { message: string }).message).toContain("locked to claude");

    client.close();
  });

  it("docs/138: re-selecting the SAME agent after pin is a no-op (no error)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    // Re-selecting the already-pinned agent must NOT error.
    client.send({ type: "set_agent", agentId: "claude" });
    // Send a follow-up message; the next agent_event proves no error short-
    // circuited the connection and claude is still the agent.
    client.send({ type: "send_message", text: "Again" });
    await waitForClaude(() => lastClaude);
    expect(lastClaude.runCalled).toBe(true);

    client.close();
  });

  it("set_model within the pinned agent's lineup succeeds mid-session", async () => {
    // After a session pins claude (first turn), the user can still pick a
    // different *claude* model (sonnet → opus). The change persists to the
    // session record and doesn't error — only cross-agent picks are blocked.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First turn pins the agent (claude, the default).
    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);
    const sid = client.sessionId;
    expect(sessionManager.get(sid)?.agentPinned).toBe(true);

    // Now switch to a different claude model mid-session. No error expected.
    client.send({ type: "set_model", model: "opus" });
    // Give the handler a tick to persist.
    await new Promise((r) => setTimeout(r, 50));
    expect(sessionManager.get(sid)?.model).toBe("opus");
    // Agent must stay claude — set_model within the same agent never moves it.
    expect(sessionManager.get(sid)?.agentId).toBe("claude");

    client.close();
  });

  it("set_model is rejected mid-session when the model belongs to a different agent", async () => {
    // After pin, picking a model from another agent (e.g. claude session →
    // gpt-5.5) is rejected: the auto-heal that swaps agents is only valid
    // pre-pin, since the pinned agent's credentials are the only ones present.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Pin claude with the first turn.
    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);
    const sid = client.sessionId;
    expect(sessionManager.get(sid)?.agentPinned).toBe(true);

    // Try to pick a codex model. Must error and not mutate session state.
    client.send({ type: "set_model", model: "gpt-5.5" });
    const err = await receiveByType(client, "error");
    expect((err as { message: string }).message).toContain("locked to Claude Code");
    expect((err as { message: string }).message).toContain("gpt-5.5");
    // Agent and model unchanged.
    expect(sessionManager.get(sid)?.agentId).toBe("claude");
    expect(sessionManager.get(sid)?.model).not.toBe("gpt-5.5");

    client.close();
  });

  it("Codex capabilities report correct feature support", () => {
    const codex = new FakeCodexProcess();
    expect(codex.capabilities.supportsImages).toBe(false);
    expect(codex.capabilities.supportsResume).toBe(true);
    expect(codex.capabilities.supportsPermissionModes).toBe(false);
    expect(codex.capabilities.models).toContain("codex-mini-latest");
  });
});
