/**
 * Integration tests for the Codex agent adapter.
 *
 * Tests the set_agent → send_message flow through the server, verifying
 * that agent switching works correctly and agent_event messages are
 * properly relayed to clients.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { ViteManager } from "../vite-manager.js";
import { FileWatcher } from "../file-watcher.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import type { FastifyInstance } from "fastify";
import type { WsServerMessage } from "../types.js";
import type {
  AgentProcess,
  AgentProcessEvents,
  AgentCapabilities,
  AgentId,
  AgentRunParams,
} from "../agents/agent-process.js";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

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
  };

  public runCalled = false;
  public lastParams: AgentRunParams | null = null;
  public killed = false;

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }

  writeStdin(_data: string): void {
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
 * claude_event, log_entry, model_info, session_started, etc.).
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

describe("Integration: Codex agent — set_agent and message flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let lastCodex: FakeCodexProcess = null as any;
  let savedOpenAIKey: string | undefined;

  beforeEach(async () => {
    lastClaude = null as any;
    lastCodex = null as any;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-codex-agent-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, "chat-history"));

    // Create registry that reports codex as installed and auth-configured
    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "claude" || binary === "codex",
      checkClaudeAuth: () => true,
    });
    await registry.detect();
    // Set OPENAI_API_KEY so codex auth check passes
    process.env.OPENAI_API_KEY = "test-key-for-codex";
    registry.refreshAuth("codex");

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      agentFactory: (agentId: AgentId) => {
        if (agentId === "codex") {
          lastCodex = new FakeCodexProcess();
          return lastCodex;
        }
        // Default: Claude — wrap FakeClaudeProcess in AgentProcess shape
        lastClaude = new FakeClaudeProcess();
        const claude = lastClaude;
        return {
          ...claude,
          agentId: "claude" as AgentId,
          capabilities: {
            supportsResume: true,
            supportsImages: true,
            supportsSystemPrompt: true,
            supportsPermissionModes: true,
            supportedPermissionModes: ["auto", "plan", "normal"],
            toolNames: ["Write", "Read", "Edit", "Bash"],
            models: ["claude-sonnet-4-20250514"],
          },
          run: (params: AgentRunParams) => {
            claude.run(params.prompt, params.sessionId, params.systemPrompt, params.images, params.cwd, params.permissionMode);
          },
          writeStdin: (data: string) => claude.writeStdin(data),
          kill: () => claude.kill(),
          on: claude.on.bind(claude),
          once: claude.once.bind(claude),
          emit: claude.emit.bind(claude),
          removeListener: claude.removeListener.bind(claude),
          removeAllListeners: claude.removeAllListeners.bind(claude),
          addListener: claude.addListener.bind(claude),
          off: claude.off.bind(claude),
          listeners: claude.listeners.bind(claude),
        } as unknown as AgentProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("set_agent with valid agentId switches the active agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Switch to Codex
    client.send({ type: "set_agent", agentId: "codex" } as any);

    // Send a message — should use Codex adapter
    client.send({ type: "send_message", text: "Hello Codex" });

    const codex = await waitForCodex(() => lastCodex);
    expect(codex.runCalled).toBe(true);
    expect(codex.lastParams?.prompt).toBe("Hello Codex");

    // Claude should NOT have been used
    expect(lastClaude).toBeNull();

    client.close();
  });

  it("set_agent with invalid agentId returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "invalid-agent" } as any);

    const msg = await receiveByType(client, "error");
    expect((msg as any).message).toContain("Unknown agent");

    client.close();
  });

  it("Codex agent_event messages are relayed to the client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" } as any);
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

    // Client should receive the agent_event (skip log_entry and claude_event)
    const agentEventMsg = await receiveByType(client, "agent_event");
    expect((agentEventMsg as any).event.type).toBe("agent_init");
    expect((agentEventMsg as any).event.agentId).toBe("codex");
    expect((agentEventMsg as any).event.sessionId).toBe("codex-thread-001");

    client.close();
  });

  it("Codex assistant events are relayed as agent_event", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" } as any);
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

    client.send({ type: "set_agent", agentId: "codex" } as any);
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

    client.send({ type: "set_agent", agentId: "codex" } as any);
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

  it("default agent is claude when no set_agent message sent", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send message without set_agent — should use Claude (default)
    client.send({ type: "send_message", text: "Hello Claude" });

    await waitForClaude(() => lastClaude);
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Hello Claude");
    expect(lastCodex).toBeNull();

    client.close();
  });

  it("switching from Codex back to Claude works", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Switch to Codex
    client.send({ type: "set_agent", agentId: "codex" } as any);
    client.send({ type: "send_message", text: "Codex prompt" });

    const codex = await waitForCodex(() => lastCodex);
    expect(codex.lastParams?.prompt).toBe("Codex prompt");

    // Complete the Codex turn
    codex.emit("event", {
      type: "agent_init",
      agentId: "codex",
      sessionId: "codex-thread-switch",
    });
    codex.emit("event", { type: "agent_result", status: "success", sessionId: "codex-thread-switch" });
    codex.emit("done", 0);

    // Drain messages
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        await client.receive(200);
      } catch { break; }
    }

    // Switch back to Claude
    client.send({ type: "set_agent", agentId: "claude" } as any);
    client.send({ type: "send_message", text: "Claude prompt" });

    await waitForClaude(() => lastClaude);
    expect(lastClaude.lastPrompt).toBe("Claude prompt");

    client.close();
  });

  it("Codex capabilities report correct feature support", () => {
    const codex = new FakeCodexProcess();
    expect(codex.capabilities.supportsImages).toBe(false);
    expect(codex.capabilities.supportsResume).toBe(true);
    expect(codex.capabilities.supportsPermissionModes).toBe(false);
    expect(codex.capabilities.models).toContain("codex-mini-latest");
  });

  it("Codex error event is relayed to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" } as any);
    client.send({ type: "send_message", text: "Fail" });

    const codex = await waitForCodex(() => lastCodex);

    codex.emit("error", new Error("codex app-server crashed"));

    const msg = await receiveByType(client, "error");
    expect((msg as any).message).toContain("Agent process error");
    expect((msg as any).message).toContain("codex app-server crashed");

    client.close();
  });
});
