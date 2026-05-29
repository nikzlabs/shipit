/**
 * Integration tests for mid-turn MCP server crash detection (docs/088).
 *
 * The Claude CLI's init event covers cold-start MCP liveness via
 * `mcp_servers[]` (see `claude-adapter.ts mapCliMcpStatus`), but doesn't
 * emit anything if a server dies mid-turn. We recover that signal in
 * `agent-listeners.ts` by:
 *
 *   1. Recording every `tool_use` we see in `agent_assistant` events
 *      (id → name).
 *   2. On any `agent_tool_result` with `is_error: true`, looking up the
 *      parent tool name. If it matches `mcp__<server>__*`, attribute the
 *      failure to that server and emit `mcp_server_status` with
 *      `state: "crashed"`.
 *
 * These tests drive the full WS pipeline (FakeClaudeProcess → orchestrator
 * → TestClient) and assert that the right `mcp_server_status` messages
 * land on the wire.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: MCP mid-turn crash detection", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-mcp-crash-"));
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
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
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir cleanup is OS-managed.
    }
  });

  it("emits mcp_server_status crashed when an mcp__<server>__* tool returns is_error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "use linear" });
    await waitForClaude(() => lastClaude);

    lastClaude.initSession("crash-session-1");
    await client.receiveType("session_started");

    // Agent invokes an MCP tool.
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-linear-1",
            name: "mcp__linear__list_issues",
            input: { team: "abc" },
          },
        ],
      },
    });
    await client.receiveType("agent_event"); // the assistant event

    // Tool returns an error — server crashed.
    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-linear-1",
            content: "ECONNREFUSED: server died unexpectedly",
            is_error: true,
          },
        ],
      },
    });
    await client.receiveType("agent_event"); // the tool_result event

    const statusMsg = await client.receiveType("mcp_server_status");
    expect(statusMsg).toMatchObject({
      type: "mcp_server_status",
      name: "linear",
      state: "crashed",
    });
    expect((statusMsg as { reason?: string }).reason).toContain(
      "ECONNREFUSED",
    );

    lastClaude.finish("crash-session-1");
    client.close();
  });

  it("dedupes per server per turn — many failing tool calls produce one crashed status", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "hammer linear" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("dedup-session");
    await client.receiveType("session_started");

    // Three tool calls to the same MCP server in one assistant event.
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} },
          { type: "tool_use", id: "t2", name: "mcp__linear__get_issue", input: { id: "X" } },
          { type: "tool_use", id: "t3", name: "mcp__linear__list_teams", input: {} },
        ],
      },
    });
    await client.receiveType("agent_event");

    // All three error out.
    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true },
          { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
          { type: "tool_result", tool_use_id: "t3", content: "boom", is_error: true },
        ],
      },
    });
    await client.receiveType("agent_event");

    // Only one crashed status — the first failure wins, the rest are deduped.
    const firstStatus = await client.receiveType("mcp_server_status");
    expect(firstStatus).toMatchObject({
      type: "mcp_server_status",
      name: "linear",
      state: "crashed",
    });

    // No further mcp_server_status emissions for the same server.
    await expect(client.receiveType("mcp_server_status", 200)).rejects.toThrow(
      /timed out/,
    );

    lastClaude.finish("dedup-session");
    client.close();
  });

  it("attributes crashes to the right server when multiple MCP servers are in play", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "multi-server" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("multi-session");
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "linear-1", name: "mcp__linear__list_issues", input: {} },
          { type: "tool_use", id: "sentry-1", name: "mcp__sentry__list_errors", input: {} },
        ],
      },
    });
    await client.receiveType("agent_event");

    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "linear-1", content: "linear down", is_error: true },
          { type: "tool_result", tool_use_id: "sentry-1", content: "sentry down", is_error: true },
        ],
      },
    });
    await client.receiveType("agent_event");

    const status1 = (await client.receiveType("mcp_server_status")) as {
      name: string;
      state: string;
      reason?: string;
    };
    const status2 = (await client.receiveType("mcp_server_status")) as {
      name: string;
      state: string;
      reason?: string;
    };
    const byName = new Map<string, typeof status1>();
    byName.set(status1.name, status1);
    byName.set(status2.name, status2);

    expect(byName.get("linear")).toMatchObject({ state: "crashed", reason: "linear down" });
    expect(byName.get("sentry")).toMatchObject({ state: "crashed", reason: "sentry down" });

    lastClaude.finish("multi-session");
    client.close();
  });

  it("does not emit crashed for non-MCP tool failures", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "regular tool" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("non-mcp-session");
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: "/missing.txt" },
          },
        ],
      },
    });
    await client.receiveType("agent_event");

    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: "ENOENT: no such file",
            is_error: true,
          },
        ],
      },
    });
    await client.receiveType("agent_event");

    // Built-in Read tool failing must NOT be reported as a crashed MCP
    // server — only `mcp__<server>__*`-prefixed names attribute back to
    // user-configured MCP servers.
    await expect(client.receiveType("mcp_server_status", 200)).rejects.toThrow(
      /timed out/,
    );

    lastClaude.finish("non-mcp-session");
    client.close();
  });

  it("does not emit crashed when the MCP tool succeeds", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "successful mcp call" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("ok-session");
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "ok-1", name: "mcp__linear__list_issues", input: {} },
        ],
      },
    });
    await client.receiveType("agent_event");

    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "ok-1",
            content: '{"issues":[]}',
            is_error: false,
          },
        ],
      },
    });
    await client.receiveType("agent_event");

    await expect(client.receiveType("mcp_server_status", 200)).rejects.toThrow(
      /timed out/,
    );

    lastClaude.finish("ok-session");
    client.close();
  });

  it("truncates absurdly long error reasons to a single line summary", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "long error" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("long-error-session");
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "long-1", name: "mcp__linear__list_issues", input: {} },
        ],
      },
    });
    await client.receiveType("agent_event");

    // 1 KB single-line error → must collapse to a bounded reason.
    const huge = "x".repeat(1024);
    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "long-1", content: huge, is_error: true },
        ],
      },
    });
    await client.receiveType("agent_event");

    const status = (await client.receiveType("mcp_server_status")) as {
      reason?: string;
    };
    expect(status.reason).toBeDefined();
    // Truncation cap is implementation-defined but must keep the WS payload small.
    expect(status.reason!.length).toBeLessThan(huge.length);
    // …and the first line should be present (i.e. we didn't drop content).
    expect(status.reason!.startsWith("x")).toBe(true);

    lastClaude.finish("long-error-session");
    client.close();
  });
});
