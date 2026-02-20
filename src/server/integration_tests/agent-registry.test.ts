/**
 * Integration tests for agent registry — list_agents, set_agent_env,
 * and enhanced set_agent validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { FileWatcher } from "../file-watcher.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import type { FastifyInstance } from "fastify";
import type { WsServerMessage } from "../types.js";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  StubFileWatcher,
} from "./test-helpers.js";

/** Receive the next message of a specific type, skipping others. */
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

describe("Integration: Agent registry — list_agents", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-agent-registry-"));

    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "claude" || binary === "codex",
      checkClaudeAuth: () => true,
    });
    await registry.detect();

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
      chatHistoryManager: new ChatHistoryManager(path.join(tmpDir, "chat-history")),
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
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

  it("list_agents returns agent availability", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_agents" } as any);

    const msg = await receiveByType(client, "agent_list");
    const data = msg as any;

    expect(data.defaultAgentId).toBe("claude");
    expect(data.agents).toHaveLength(2);

    const claude = data.agents.find((a: any) => a.id === "claude");
    expect(claude.installed).toBe(true);
    expect(claude.authConfigured).toBe(true);

    const codex = data.agents.find((a: any) => a.id === "codex");
    expect(codex.installed).toBe(true);
    // Codex auth depends on OPENAI_API_KEY being set
    expect(codex.name).toBe("Codex");

    client.close();
  });

  it("set_agent rejects unknown agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_agent", agentId: "unknown-agent" } as any);

    const msg = await receiveByType(client, "error");
    expect((msg as any).message).toContain("Unknown agent");

    client.close();
  });

  it("set_agent accepts installed agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Claude is installed and auth-configured, should succeed (no error)
    client.send({ type: "set_agent", agentId: "claude" } as any);

    // Send list_agents to verify no error was sent
    client.send({ type: "list_agents" } as any);
    const msg = await receiveByType(client, "agent_list");
    expect(msg.type).toBe("agent_list");

    client.close();
  });
});

describe("Integration: Agent registry — set_agent_env", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let savedOpenAIKey: string | undefined;

  beforeEach(async () => {
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-agent-env-"));

    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "claude" || binary === "codex",
      checkClaudeAuth: () => true,
    });
    await registry.detect();

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
      chatHistoryManager: new ChatHistoryManager(path.join(tmpDir, "chat-history")),
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
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

  it("set_agent_env sets env var and updates auth status", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Initially Codex auth is not configured
    client.send({ type: "list_agents" } as any);
    const listBefore = await receiveByType(client, "agent_list") as any;
    const codexBefore = listBefore.agents.find((a: any) => a.id === "codex");
    expect(codexBefore.authConfigured).toBe(false);

    // Set the env var
    client.send({
      type: "set_agent_env",
      agentId: "codex",
      key: "OPENAI_API_KEY",
      value: "sk-test-key-123",
    } as any);

    const envMsg = await receiveByType(client, "agent_env_set");
    expect((envMsg as any).success).toBe(true);
    expect((envMsg as any).key).toBe("OPENAI_API_KEY");

    // Server should also send an updated agent_list
    const listAfter = await receiveByType(client, "agent_list") as any;
    const codexAfter = listAfter.agents.find((a: any) => a.id === "codex");
    expect(codexAfter.authConfigured).toBe(true);

    client.close();
  });

  it("set_agent_env rejects disallowed env keys", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "set_agent_env",
      agentId: "codex",
      key: "PATH",
      value: "/usr/bin",
    } as any);

    const msg = await receiveByType(client, "error");
    expect((msg as any).message).toContain("not in the allowlist");

    client.close();
  });

  it("set_agent_env rejects empty value", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "set_agent_env",
      agentId: "codex",
      key: "OPENAI_API_KEY",
      value: "   ",
    } as any);

    const msg = await receiveByType(client, "error");
    expect((msg as any).message).toContain("empty");

    client.close();
  });
});
