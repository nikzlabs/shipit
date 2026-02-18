import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: Worktree sessions", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess | null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-worktree-"));
    lastClaude = null;

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess() as unknown as FakeClaudeProcess;
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper: create a session with a git repo and activate it.
   * Sends a message, waits for Claude to start, emits init + finish,
   * then drains all resulting WS messages. Returns the app session ID.
   */
  async function createAndActivateSession(
    client: TestClient,
    title: string,
  ): Promise<string> {
    client.send({ type: "send_message", text: title });

    const claude = await waitForClaude(() => lastClaude);
    // Emit init event so the server sends session_started
    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session",
      tools: ["Write"],
    });
    claude.finish("test-session");

    // Drain all messages until there's a pause
    let sessionId = "";
    try {
      while (true) {
        const msg = await client.receive(500);
        if (msg.type === "session_started") {
          sessionId = (msg as any).session.id;
        }
      }
    } catch {
      // Timeout — no more messages
    }

    // Fallback: look up in session manager if we missed the WS message
    if (!sessionId) {
      const sessions = sessionManager.list();
      if (sessions.length > 0) {
        sessionId = sessions[0].id;
      }
    }

    return sessionId;
  }

  // ---- fork_session ----

  it("fork_session creates a worktree session from active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const parentId = await createAndActivateSession(client, "Parent session");
    expect(parentId).toBeTruthy();

    // Fork the session
    client.send({ type: "fork_session", branchName: "feature-1" } as any);

    // Should receive session_forked and session_list
    const deadline = Date.now() + 5000;
    let forkedMsg: any = null;
    let listMsg: any = null;
    while (Date.now() < deadline && (!forkedMsg || !listMsg)) {
      const msg = await client.receive();
      if (msg.type === "session_forked") forkedMsg = msg;
      if (msg.type === "session_list") listMsg = msg;
    }

    expect(forkedMsg).not.toBeNull();
    expect(forkedMsg.session.parentSessionId).toBe(parentId);
    expect(forkedMsg.session.branch).toBe("feature-1");
    expect(forkedMsg.session.sessionType).toBe("worktree");
    expect(forkedMsg.parentSessionId).toBe(parentId);

    // Verify the worktree directory exists
    expect(fs.existsSync(forkedMsg.session.workspaceDir)).toBe(true);

    client.close();
  });

  it("fork_session rejects empty branch name", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createAndActivateSession(client, "Parent");

    client.send({ type: "fork_session", branchName: "  " } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Branch name is required");

    client.close();
  });

  it("fork_session rejects invalid branch name characters", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createAndActivateSession(client, "Parent");

    client.send({ type: "fork_session", branchName: "has spaces" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid branch name");

    client.close();
  });

  it("fork_session rejects when no active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "fork_session", branchName: "feature" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("No active session to fork from");

    client.close();
  });

  // ---- list_worktrees ----

  it("list_worktrees returns empty when no active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_worktrees" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("worktree_list");
    expect((msg as any).worktrees).toEqual([]);

    client.close();
  });

  it("list_worktrees returns worktrees for active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createAndActivateSession(client, "Parent");

    // Fork twice
    client.send({ type: "fork_session", branchName: "branch-a" } as any);
    await client.receive(); // session_forked
    await client.receive(); // session_list

    client.send({ type: "fork_session", branchName: "branch-b" } as any);
    await client.receive(); // session_forked
    await client.receive(); // session_list

    // List worktrees
    client.send({ type: "list_worktrees" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("worktree_list");
    const worktrees = (msg as any).worktrees;
    // Should have 3: parent + 2 worktrees
    expect(worktrees.length).toBeGreaterThanOrEqual(3);
    const branches = worktrees.map((w: any) => w.branch);
    expect(branches).toContain("branch-a");
    expect(branches).toContain("branch-b");

    client.close();
  });

  // ---- archive_session with worktree ----

  it("archive_session blocks when session has worktree children", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const parentId = await createAndActivateSession(client, "Parent");

    // Fork it
    client.send({ type: "fork_session", branchName: "child-branch" } as any);
    await client.receive(); // session_forked
    await client.receive(); // session_list

    // Try to archive the parent
    client.send({ type: "archive_session", sessionId: parentId });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Cannot archive a session that has worktree sessions");

    client.close();
  });

  it("archive_session cleans up worktree when archiving child session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createAndActivateSession(client, "Parent");

    // Fork it
    client.send({ type: "fork_session", branchName: "to-archive" } as any);
    const forkedMsg = await client.receive(); // session_forked
    await client.receive(); // session_list

    const childId = (forkedMsg as any).session.id;
    const childDir = (forkedMsg as any).session.workspaceDir;

    // Archive the child
    client.send({ type: "archive_session", sessionId: childId });
    const listMsg = await client.receive();

    expect(listMsg.type).toBe("session_list");

    // The child session should be archived
    const child = sessionManager.get(childId);
    expect(child?.archived).toBe(true);

    // The worktree directory should have been removed
    expect(fs.existsSync(childDir)).toBe(false);

    client.close();
  });

  // ---- merge_session ----

  it("merge_session returns error when no active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "merge_session", sourceSessionId: "nonexistent" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("No active session to merge into");

    client.close();
  });

  it("merge_session returns error for empty source ID", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createAndActivateSession(client, "Parent");

    client.send({ type: "merge_session", sourceSessionId: "" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Source session ID is required");

    client.close();
  });

  it("merge_session returns error for nonexistent source", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createAndActivateSession(client, "Parent");

    client.send({ type: "merge_session", sourceSessionId: "nonexistent" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Source session not found");

    client.close();
  });

  it("merge_session merges a worktree branch into the active session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const parentId = await createAndActivateSession(client, "Parent");
    expect(parentId).toBeTruthy();

    // Fork it
    client.send({ type: "fork_session", branchName: "to-merge" } as any);
    const forkedMsg = await client.receive();
    await client.receive(); // session_list

    const childId = (forkedMsg as any).session.id;
    const childDir = (forkedMsg as any).session.workspaceDir;

    // Make changes in the child worktree
    fs.writeFileSync(path.join(childDir, "feature.txt"), "new feature");
    const childGit = new GitManager(childDir);
    await childGit.autoCommit("Add feature");

    // Merge the child into the parent (parent is still active)
    client.send({ type: "merge_session", sourceSessionId: childId } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("merge_result");
    expect((msg as any).success).toBe(true);
    expect((msg as any).message).toContain("to-merge");

    // Verify the file exists in the parent
    const parentSession = sessionManager.get(parentId);
    expect(parentSession).toBeDefined();
    expect(fs.existsSync(path.join(parentSession!.workspaceDir!, "feature.txt"))).toBe(true);

    client.close();
  });
});
