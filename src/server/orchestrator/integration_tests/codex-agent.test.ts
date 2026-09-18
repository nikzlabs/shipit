import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { AgentRegistry, CODEX_TOOL_NAMES } from "../../shared/agent-registry.js";
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

class FakeCodexProcess extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "codex";
  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: [...CODEX_TOOL_NAMES],
    models: ["codex-mini-latest", "o4-mini"],
    supportsReview: false,
    supportsSteering: false,
    supportsCompaction: false,
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

  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } {
    return {};
  }

  finish(threadId = "codex-thread-001", code = 0) {
    this.emit("event", { type: "agent_result", status: "success", sessionId: threadId });
    this.emit("done", code);
  }
}

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
  let sessions: SessionManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    lastCodex = null as any;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-codex-agent-"));

    const sessionManager = new SessionManager(dbManager);
    sessions = sessionManager;
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
    await client.receive();

    client.send({ type: "send_message", text: "Hello Codex" });

    const codex = await waitForCodex(() => lastCodex);
    expect(codex.runCalled).toBe(true);
    expect(codex.lastParams?.prompt).toBe("Hello Codex");

    expect(lastClaude).toBeNull();

    client.close();
  });

  it("model param wins over a stale agent param for an unpinned session (docs/142 C)", async () => {
    const client = await TestClient.connect(port, undefined, { model: "claude-opus-5", agent: "codex" });
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });

    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);
    expect(lastCodex).toBeNull();

    client.close();
  });

  it("set_model with another agent's model self-heals by switching agent (Codex → Opus)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_model", model: "claude-opus-5" });
    await new Promise((r) => setTimeout(r, 50));

    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.runCalled).toBe(true);
    expect(lastCodex).toBeNull();

    client.close();
  });

  it("carries a session pinned to a RETIRED model onto its successor (docs/252 req 13)", async () => {
    sessions.track("s-retired");
    sessions.setAgentId("s-retired", "codex" as AgentId);
    sessions.setAgentPinned("s-retired");
    sessions.setModelSelection("s-retired", {
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.6",
    });

    const client = await TestClient.connect(port, "s-retired");
    await client.receive();

    const session = sessions.get("s-retired");
    expect(session?.model).toBe("gpt-5.6-sol");
    expect(session?.serviceId).toBe("openai");
    expect(session?.billingMode).toBe("key");

    client.send({ type: "send_message", text: "Hello" });
    const codex = await waitForCodex(() => lastCodex);
    expect(codex.lastParams?.model).toBe("gpt-5.6-sol");

    client.close();
  });

  it("set_model rejects a model no installed+authed agent supports", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_model", model: "totally-made-up-model" });

    const err = await receiveByType(client, "error");
    expect((err as any).message).toContain("is not available");

    client.close();
  });

  it("Codex agent_event messages are relayed to the client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Write hello world" });

    const codex = await waitForCodex(() => lastCodex);

    codex.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: "codex-thread-001",
      model: "codex-mini-latest",
      tools: ["shell", "apply_patch"],
    });

    const agentEventMsg = await receiveByType(client, "agent_event");
    expect((agentEventMsg as any).event.type).toBe("agent_init");
    expect((agentEventMsg as any).event.agentId).toBe("codex");
    expect((agentEventMsg as any).event.sessionId).toBe("codex-thread-001");

    client.close();
  });

  it("Codex assistant events are relayed as agent_event", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });

    const codex = await waitForCodex(() => lastCodex);

    codex.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: "codex-thread-001",
      model: "codex-mini-latest",
    });

    await receiveByType(client, "session_started");

    codex.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "I can help with that!" }],
    });

    const assistantEvent = await receiveByType(client, "agent_event");
    expect((assistantEvent as any).event.type).toBe("agent_assistant");
    expect((assistantEvent as any).event.content[0].text).toBe("I can help with that!");

    client.close();
  });

  it("Codex tool_use events are relayed as agent_event", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Run ls" });

    const codex = await waitForCodex(() => lastCodex);

    codex.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: "codex-thread-002",
    });
    await receiveByType(client, "session_started");

    codex.emit("event", {
      type: "agent_assistant",
      content: [{
        type: "tool_use",
        id: "call-001",
        name: "shell",
        input: { command: "ls -la" },
      }],
    });

    const toolEvent = await receiveByType(client, "agent_event");
    expect((toolEvent as any).event.type).toBe("agent_assistant");
    expect((toolEvent as any).event.content[0].type).toBe("tool_use");
    expect((toolEvent as any).event.content[0].name).toBe("shell");
    expect((toolEvent as any).event.content[0].input.command).toBe("ls -la");

    client.close();
  });

  it("Codex agent_result event completes the turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Done?" });

    const codex = await waitForCodex(() => lastCodex);

    codex.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: "codex-thread-003",
    });
    await receiveByType(client, "session_started");

    codex.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "codex-thread-003",
      tokens: { input: 100, output: 50 },
    });
    codex.emit("done", 0);

    const resultEvent = await receiveByType(client, "agent_event");
    expect((resultEvent as any).event.type).toBe("agent_result");
    expect((resultEvent as any).event.status).toBe("success");

    client.close();
  });

  it("Codex error event is relayed to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

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
    const created = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "codex session" },
    });
    const sessionId = created.json().sessionId as string;

    sessionManager.setAgentId(sessionId, "codex" as AgentId);
    sessionManager.setModel(sessionId, "gpt-5.5");

    await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      payload: { running: false },
    });

    const client = await TestClient.connect(port, sessionId);
    await client.receive();
    client.send({ type: "send_message", text: "what model are you?" });

    const codex = await waitForCodex(() => lastCodex);
    expect(codex.runCalled).toBe(true);
    expect(lastClaude).toBeNull();

    client.close();
  });

  it("default agent is claude when defaultAgentId is not set", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello Claude" });

    await waitForClaude(() => lastClaude);
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Hello Claude");
    expect(lastCodex).toBeNull();

    client.close();
  });

  it("docs/138: set_agent is rejected once the session is pinned (first turn)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);
    expect(lastClaude.runCalled).toBe(true);

    client.send({ type: "set_agent", agentId: "codex" });
    const err = await receiveByType(client, "error");
    expect((err as { message: string }).message).toContain("locked to claude");

    client.close();
  });

  it("docs/138: re-selecting the SAME agent after pin is a no-op (no error)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    client.send({ type: "set_agent", agentId: "claude" });
    client.send({ type: "send_message", text: "Again" });
    await waitForClaude(() => lastClaude);
    expect(lastClaude.runCalled).toBe(true);

    client.close();
  });

  it("set_model within the pinned agent's lineup succeeds mid-session", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);
    const sid = client.sessionId;
    expect(sessionManager.get(sid)?.agentPinned).toBe(true);

    client.send({ type: "set_model", model: "claude-opus-5" });
    await new Promise((r) => setTimeout(r, 50));
    expect(sessionManager.get(sid)?.model).toBe("claude-opus-5");
    expect(sessionManager.get(sid)?.agentId).toBe("claude");

    client.close();
  });

  it("set_model is rejected mid-session when the model belongs to a different agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);
    const sid = client.sessionId;
    expect(sessionManager.get(sid)?.agentPinned).toBe(true);

    client.send({ type: "set_model", model: "gpt-5.5" });
    const err = await receiveByType(client, "error");
    expect((err as { message: string }).message).toContain("locked to Claude Code");
    expect((err as { message: string }).message).toContain("gpt-5.5");
    expect(sessionManager.get(sid)?.agentId).toBe("claude");
    expect(sessionManager.get(sid)?.model).not.toBe("gpt-5.5");

    client.close();
  });

  it("Codex capabilities report correct feature support", () => {
    const codex = new FakeCodexProcess();
    expect(codex.capabilities.supportsImages).toBe(true);
    expect(codex.capabilities.supportsResume).toBe(true);
    expect(codex.capabilities.supportsPermissionModes).toBe(false);
    expect(codex.capabilities.models).toContain("codex-mini-latest");
  });
});
