import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import { BranchManager } from "../branches.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Conversation branching & checkpoints", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let branchManager: BranchManager;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-branching-"));
    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));
    chatHistoryManager = new ChatHistoryManager(path.join(tmpDir, "chat-history"));
    branchManager = new BranchManager(path.join(tmpDir, "branches"));

    app = await buildApp({
      gitManager,
      sessionManager,
      chatHistoryManager,
      branchManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
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
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper: send a message and complete the Claude turn.
   * Returns the session ID from the session_started event.
   */
  async function doMessageTurn(
    client: TestClient,
    text: string,
    sessionId?: string,
  ): Promise<string> {
    client.send({ type: "send_message", text, sessionId });
    const claude = await waitForClaude(() => lastClaude);

    // Simulate init event
    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-session-1",
    });

    // Collect session ID from session_started
    let sid = sessionId;
    if (!sid) {
      // New session: drain until we find session_started
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const msg = await client.receive();
        if (msg.type === "session_started") {
          sid = (msg as any).session.id;
          break;
        }
      }
      if (!sid) throw new Error("Never received session_started");
    } else {
      // Existing session: drain system.init event + session_started
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const msg = await client.receive();
        if (msg.type === "session_started") break;
      }
    }

    // Simulate assistant response
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: `Response to: ${text}` }] },
    });

    // Complete the turn
    claude.finish("agent-session-1");

    // Drain all remaining messages for this turn (claude_event, result, done, git_committed, logs...)
    const deadline = Date.now() + 5000;
    let resultSeen = false;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(500);
        if (msg.type === "claude_event" && (msg as any).event?.type === "result") {
          resultSeen = true;
        }
        // Stop after we've seen the git_committed (or timeout)
        if (msg.type === "git_committed") break;
      } catch {
        // Timeout on receive — we've drained everything
        break;
      }
    }

    return sid!;
  }

  // ---- list_branches ----

  it("list_branches returns error when no active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_branches" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "error",
      message: "No active session",
    });

    client.close();
  });

  it("list_branches returns branches after session established", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await doMessageTurn(client, "Hello");

    client.send({ type: "list_branches" } as any);

    // Find the branch_list response (may have log entries interspersed)
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "branch_list") {
        expect(msg.branches).toHaveLength(1);
        expect(msg.branches[0].name).toBe("main");
        expect(msg.branches[0].isActive).toBe(true);
        expect(msg.activeBranchId).toBe(msg.branches[0].id);
        client.close();
        return;
      }
    }
    throw new Error("Never received branch_list");
  });

  // ---- create_checkpoint ----

  it("create_checkpoint returns error when no active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "create_checkpoint" } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "error",
      message: "No active session",
    });

    client.close();
  });

  it("create_checkpoint creates checkpoint on active branch", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await doMessageTurn(client, "Build a todo app");

    client.send({ type: "create_checkpoint", label: "Before refactor" } as any);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "checkpoint_created") {
        expect(msg.checkpoint.label).toBe("Before refactor");
        expect(msg.checkpoint.sessionId).toBe(sessionId);
        expect(msg.checkpoint.messageIndex).toBeGreaterThan(0);
        expect(msg.branchId).toBeDefined();
        client.close();
        return;
      }
    }
    throw new Error("Never received checkpoint_created");
  });

  it("create_checkpoint rejects label over 200 characters", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await doMessageTurn(client, "Hello");

    const longLabel = "x".repeat(201);
    client.send({ type: "create_checkpoint", label: longLabel } as any);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "error") {
        expect(msg.message).toBe("Checkpoint label too long (max 200 characters)");
        client.close();
        return;
      }
    }
    throw new Error("Never received error");
  });

  // ---- branch_from_checkpoint ----

  it("branch_from_checkpoint creates new branch", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await doMessageTurn(client, "Build an app");

    // Create checkpoint
    client.send({ type: "create_checkpoint", label: "v1" } as any);
    let checkpointId: string | undefined;
    let deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "checkpoint_created") {
        checkpointId = msg.checkpoint.id;
        break;
      }
    }
    expect(checkpointId).toBeDefined();

    // Branch from it
    client.send({ type: "branch_from_checkpoint", checkpointId: checkpointId! } as any);
    const response = await client.receiveSkipLogs(5000);

    expect(response.type).toBe("branch_created");
    if (response.type === "branch_created") {
      expect(response.branch.name).toBe("Branch 1");
      expect(response.branch.parentCheckpointId).toBe(checkpointId);
      expect(response.branch.isActive).toBe(true);
      expect(Array.isArray(response.messages)).toBe(true);
    }

    client.close();
  });

  it("branch_from_checkpoint returns error for unknown checkpoint", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await doMessageTurn(client, "Hello");

    client.send({
      type: "branch_from_checkpoint",
      checkpointId: "nonexistent",
    } as any);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "error") {
        expect(msg.message).toBe("Checkpoint not found");
        client.close();
        return;
      }
    }
    throw new Error("Never received error");
  });

  it("branch_from_checkpoint returns error when no active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "branch_from_checkpoint",
      checkpointId: "some-id",
    } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "error",
      message: "No active session",
    });

    client.close();
  });

  // ---- switch_branch ----

  it("switch_branch switches to an existing branch and returns messages", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await doMessageTurn(client, "Hello");

    // Get main branch ID
    client.send({ type: "list_branches" } as any);
    let mainBranchId: string | undefined;
    let deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "branch_list") {
        mainBranchId = msg.branches[0].id;
        break;
      }
    }
    expect(mainBranchId).toBeDefined();

    // Create checkpoint and branch
    client.send({ type: "create_checkpoint" } as any);
    let checkpointId: string | undefined;
    deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "checkpoint_created") {
        checkpointId = msg.checkpoint.id;
        break;
      }
    }

    client.send({ type: "branch_from_checkpoint", checkpointId: checkpointId! } as any);
    const branchResp = await client.receiveSkipLogs(5000);
    expect(branchResp.type).toBe("branch_created");

    // Switch back to main
    client.send({ type: "switch_branch", branchId: mainBranchId! } as any);
    const switchResp = await client.receiveSkipLogs(5000);

    expect(switchResp.type).toBe("branch_switched");
    if (switchResp.type === "branch_switched") {
      expect(switchResp.branch.name).toBe("main");
      expect(switchResp.branch.isActive).toBe(true);
      expect(Array.isArray(switchResp.messages)).toBe(true);
    }

    client.close();
  });

  it("switch_branch returns error for unknown branch", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await doMessageTurn(client, "Hello");

    client.send({
      type: "switch_branch",
      branchId: "nonexistent",
    } as any);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "error") {
        expect(msg.message).toBe("Branch not found");
        client.close();
        return;
      }
    }
    throw new Error("Never received error");
  });

  it("switch_branch returns error when no active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "switch_branch",
      branchId: "some-id",
    } as any);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "error",
      message: "No active session",
    });

    client.close();
  });

  // ---- Session lifecycle ----

  it("delete_session cleans up branch data", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await doMessageTurn(client, "Hello");

    // Create a checkpoint
    client.send({ type: "create_checkpoint" } as any);
    let deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "checkpoint_created") break;
    }

    // Verify branch data exists
    const beforeDelete = branchManager.listBranches(sessionId);
    expect(beforeDelete.branches[0].checkpoints).toHaveLength(1);

    // Delete the session
    client.send({ type: "delete_session", sessionId });
    deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const msg = await client.receive();
      if (msg.type === "session_list") break;
    }

    // Verify branch data is cleaned up (new load returns defaults)
    const afterDelete = branchManager.listBranches(sessionId);
    expect(afterDelete.branches[0].checkpoints).toHaveLength(0);

    client.close();
  });
});
