/**
 * Integration tests for the Codex adapter flow.
 *
 * Verifies that:
 * 1. set_agent switches to the Codex adapter
 * 2. send_message with a Codex agent produces normalized agent_event messages
 * 3. Codex-specific events (thread.started, item.*, turn.*) are correctly
 *    translated to the AgentEvent protocol
 * 4. Error paths (turn.failed, process exit without result) are handled
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { ViteManager } from "../vite-manager.js";
import { FileWatcher } from "../file-watcher.js";
import { ClaudeAdapter } from "../agents/claude-adapter.js";
import { CodexAdapter } from "../agents/codex-adapter.js";
import type { AgentId, AgentProcess } from "../agents/agent-process.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// FakeCodexProcess — test double for CodexProcess
// ---------------------------------------------------------------------------

class FakeCodexProcess extends EventEmitter {
  public runCalled = false;
  public lastPrompt = "";
  public lastApprovalMode: string | undefined;
  public lastModel: string | undefined;
  public lastCwd: string | undefined;
  public killed = false;
  public stdinData: string[] = [];

  run(prompt: string, approvalMode?: string, model?: string, cwd?: string) {
    this.runCalled = true;
    this.lastPrompt = prompt;
    this.lastApprovalMode = approvalMode;
    this.lastModel = model;
    this.lastCwd = cwd;
  }

  kill() {
    this.killed = true;
  }

  writeStdin(data: string) {
    this.stdinData.push(data);
  }

  /** Simulate a complete Codex turn — thread.started → turn.started → turn.completed. */
  finishTurn(threadId = "test-thread", usage?: { input_tokens?: number; output_tokens?: number }) {
    this.emit("event", { type: "thread.started", thread_id: threadId });
    this.emit("event", { type: "turn.started" });
    this.emit("event", { type: "turn.completed", usage });
    this.emit("done", 0);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait until a FakeCodexProcess has run() called on it. */
async function waitForCodex(
  getCodex: () => FakeCodexProcess | null,
  timeoutMs = 5000,
): Promise<FakeCodexProcess> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const c = getCodex();
    if (c?.runCalled) return c;
    if (Date.now() > deadline) throw new Error("Timed out waiting for CodexProcess.run()");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: Codex agent flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastCodex: FakeCodexProcess;
  let lastClaude: FakeClaudeProcess;

  beforeEach(async () => {
    lastCodex = null as any;
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-codex-int-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, "chat-history"));

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: (agentId: AgentId): AgentProcess => {
        if (agentId === "codex") {
          lastCodex = new FakeCodexProcess();
          return new CodexAdapter(lastCodex as any);
        }
        lastClaude = new FakeClaudeProcess();
        return new ClaudeAdapter(lastClaude as any);
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
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("set_agent switches to codex and send_message uses codex adapter", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Switch to codex agent
    client.send({ type: "set_agent", agentId: "codex" });

    // Send a message — should go to the Codex adapter
    client.send({ type: "send_message", text: "Hello Codex" });

    await waitForCodex(() => lastCodex);
    expect(lastCodex.lastPrompt).toBe("Hello Codex");
    expect(lastCodex.lastApprovalMode).toBe("full-auto");

    // Claude should not have been created
    expect(lastClaude).toBeNull();

    client.close();
  });

  it("set_agent with invalid agentId returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send invalid agent ID
    client.send({ type: "set_agent", agentId: "invalid" as any });

    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Unknown agent");

    client.close();
  });

  it("codex thread.started emits agent_event with agent_init", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" });
    client.send({ type: "send_message", text: "Hello" });

    await waitForCodex(() => lastCodex);

    // Simulate Codex starting a thread
    lastCodex.emit("event", {
      type: "thread.started",
      thread_id: "codex-thread-abc",
    });

    // We should receive an agent_event with type agent_init plus the legacy claude_event.
    // The server sends agent_event first, then claude_event, then session_started.
    // Collect several messages to get both.
    const msgs: any[] = [];
    const deadline = Date.now() + 3000;
    let foundInit = false;
    while (Date.now() < deadline) {
      const msg = await client.receive(1000).catch(() => null);
      if (!msg) break;
      msgs.push(msg);
      if (msg.type === "agent_event" && msg.event?.type === "agent_init") foundInit = true;
      // Keep collecting a few more after agent_init to capture the legacy event
      if (foundInit && msgs.length >= 5) break;
    }

    const agentEvent = msgs.find((m) => m.type === "agent_event" && m.event?.type === "agent_init");
    expect(agentEvent).toBeDefined();
    expect(agentEvent.event.agentId).toBe("codex");
    expect(agentEvent.event.sessionId).toBe("codex-thread-abc");

    // Should also receive legacy claude_event for backward compatibility
    const legacyEvent = msgs.find((m) => m.type === "claude_event" && m.event?.type === "system");
    expect(legacyEvent).toBeDefined();
    expect(legacyEvent.event.session_id).toBe("codex-thread-abc");

    client.close();
  });

  it("codex agent_message items are relayed as assistant events", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" });
    client.send({ type: "send_message", text: "Summarize the repo" });

    await waitForCodex(() => lastCodex);

    // Thread starts
    lastCodex.emit("event", { type: "thread.started", thread_id: "t-1" });
    lastCodex.emit("event", { type: "turn.started" });

    // Agent produces a message
    lastCodex.emit("event", {
      type: "item.completed",
      item: {
        id: "msg-1",
        type: "agent_message",
        text: "Here is the summary of your repo.",
      },
    });

    // Collect messages until we see the assistant agent_event
    const msgs: any[] = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive(1000).catch(() => null);
      if (!msg) break;
      msgs.push(msg);
      if (msg.type === "agent_event" && msg.event?.type === "agent_assistant") break;
    }

    const assistantEvent = msgs.find((m) => m.type === "agent_event" && m.event?.type === "agent_assistant");
    expect(assistantEvent).toBeDefined();
    expect(assistantEvent.event.content).toEqual([
      { type: "text", text: "Here is the summary of your repo." },
    ]);

    client.close();
  });

  it("codex command_execution items are relayed as tool_use events", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" });
    client.send({ type: "send_message", text: "Run the tests" });

    await waitForCodex(() => lastCodex);

    lastCodex.emit("event", { type: "thread.started", thread_id: "t-2" });
    lastCodex.emit("event", { type: "turn.started" });

    // Command starts
    lastCodex.emit("event", {
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        status: "in_progress",
      },
    });

    // Collect until we see the tool_use agent_event
    const msgs: any[] = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive(1000).catch(() => null);
      if (!msg) break;
      msgs.push(msg);
      if (msg.type === "agent_event" && msg.event?.type === "agent_assistant") {
        const content = msg.event.content;
        if (content?.some((b: any) => b.type === "tool_use" && b.name === "shell")) break;
      }
    }

    const shellEvent = msgs.find((m) =>
      m.type === "agent_event" &&
      m.event?.type === "agent_assistant" &&
      m.event?.content?.some((b: any) => b.type === "tool_use" && b.name === "shell"),
    );
    expect(shellEvent).toBeDefined();
    const toolBlock = shellEvent.event.content.find((b: any) => b.name === "shell");
    expect(toolBlock.input.command).toBe("npm test");

    client.close();
  });

  it("codex turn.completed emits agent_result with success", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" });
    client.send({ type: "send_message", text: "Hello" });

    await waitForCodex(() => lastCodex);

    // Simulate a complete turn
    lastCodex.emit("event", { type: "thread.started", thread_id: "t-3" });
    lastCodex.emit("event", { type: "turn.started" });
    lastCodex.emit("event", {
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "Done." },
    });
    lastCodex.emit("event", {
      type: "turn.completed",
      usage: { input_tokens: 800, output_tokens: 200, cached_input_tokens: 50 },
    });
    lastCodex.emit("done", 0);

    // Collect all messages
    const msgs: any[] = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive(500).catch(() => null);
      if (!msg) break;
      msgs.push(msg);
    }

    const resultEvent = msgs.find((m) =>
      m.type === "agent_event" && m.event?.type === "agent_result",
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent.event.status).toBe("success");
    expect(resultEvent.event.sessionId).toBe("t-3");
    expect(resultEvent.event.tokens).toMatchObject({
      input: 800,
      output: 200,
      cacheRead: 50,
    });

    client.close();
  });

  it("codex turn.failed emits agent_result with error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" });
    client.send({ type: "send_message", text: "Hello" });

    await waitForCodex(() => lastCodex);

    lastCodex.emit("event", { type: "thread.started", thread_id: "t-4" });
    lastCodex.emit("event", { type: "turn.started" });
    lastCodex.emit("event", {
      type: "turn.failed",
      error: { message: "Rate limit exceeded" },
    });
    lastCodex.emit("done", 1);

    const msgs: any[] = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive(500).catch(() => null);
      if (!msg) break;
      msgs.push(msg);
    }

    const resultEvent = msgs.find((m) =>
      m.type === "agent_event" && m.event?.type === "agent_result" && m.event?.status === "error",
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent.event.error).toBe("Rate limit exceeded");

    client.close();
  });

  it("codex process exit without result sends error to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" });
    client.send({ type: "send_message", text: "Hello" });

    await waitForCodex(() => lastCodex);

    // Process exits with code 1 without any events
    lastCodex.emit("done", 1);

    const msg = await client.receiveSkipLogs();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("exited with code 1");

    client.close();
  });

  it("disconnecting kills the codex process", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" });
    client.send({ type: "send_message", text: "test" });

    await waitForCodex(() => lastCodex);
    const codex = lastCodex;

    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(codex.killed).toBe(true);
  });

  it("defaults to claude when no set_agent is sent", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send message without switching agent — should use default (claude)
    client.send({ type: "send_message", text: "Hello Claude" });

    // Wait for Claude to be created (not Codex)
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (lastClaude?.runCalled) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(lastClaude?.runCalled).toBe(true);
    expect(lastClaude?.lastPrompt).toBe("Hello Claude");
    expect(lastCodex).toBeNull();

    client.close();
  });

  it("codex permission mode 'auto' maps to full-auto approval mode", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" });
    client.send({ type: "send_message", text: "test", permissionMode: "auto" });

    await waitForCodex(() => lastCodex);
    expect(lastCodex.lastApprovalMode).toBe("full-auto");

    client.close();
  });

  it("codex permission mode 'plan' maps to suggest approval mode", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "codex" });
    client.send({ type: "send_message", text: "test", permissionMode: "plan" });

    await waitForCodex(() => lastCodex);
    expect(lastCodex.lastApprovalMode).toBe("suggest");

    client.close();
  });
});
