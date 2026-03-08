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
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Session clones", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess | null;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-session-clone-"));
    lastClaude = null;

    sessionManager = new SessionManager(dbManager);

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
    dbManager.close();
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

  // ---- fork_session (HTTP) ----

  it("fork_session creates a cloned session via HTTP", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const parentId = await createAndActivateSession(client, "Parent session");
    expect(parentId).toBeTruthy();
    client.close();

    // Fork the session via HTTP
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/fork`,
      payload: { branchName: "feature-1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.session.title).toContain("feature-1");
    expect(body.parentSessionId).toBe(parentId);
    expect(body.sessions.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("fork_session rejects empty branch name via HTTP", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const parentId = await createAndActivateSession(client, "Parent");
    client.close();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/fork`,
      payload: { branchName: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("fork_session rejects invalid branch name characters via HTTP", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const parentId = await createAndActivateSession(client, "Parent");
    client.close();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/fork`,
      payload: { branchName: "has spaces" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("fork_session returns 404 for nonexistent session via HTTP", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nonexistent/fork",
      payload: { branchName: "feature" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- list sibling sessions ----

  it("list sibling sessions returns 404 for nonexistent session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/worktrees" });
    expect(res.statusCode).toBe(404);
  });

  it("list sibling sessions returns empty for session without remoteUrl", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await createAndActivateSession(client, "Parent");

    // Sessions without remoteUrl have no branch, so sibling sessions list is filtered to entries with branch
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/worktrees` });
    expect(res.statusCode).toBe(200);
    const worktrees = res.json().worktrees;
    expect(worktrees.length).toBe(0);

    client.close();
  });

  // ---- archive_session with clone ----

  it("archive_session cleans up clone when archiving child session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const parentId = await createAndActivateSession(client, "Parent");
    client.close();

    // Fork via HTTP
    const forkRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/fork`,
      payload: { branchName: "to-archive" },
    });
    expect(forkRes.statusCode).toBe(200);
    const childId = forkRes.json().session.id;
    const childSession = sessionManager.get(childId);
    const childDir = childSession!.workspaceDir!;

    // Archive the child via HTTP
    const archiveRes = await app.inject({ method: "DELETE", url: `/api/sessions/${childId}` });
    expect(archiveRes.statusCode).toBe(200);

    // The child session should be archived
    const child = sessionManager.get(childId);
    expect(child?.archived).toBe(true);

    // The session directory should have been removed
    expect(fs.existsSync(childDir)).toBe(false);
  }, 15_000);

  // ---- merge_session (HTTP) ----

  it("merge_session returns 404 for nonexistent target session via HTTP", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nonexistent/git/merge",
      payload: { sourceSessionId: "anything" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("merge_session merges a session branch into the parent session via HTTP", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const parentId = await createAndActivateSession(client, "Parent");
    expect(parentId).toBeTruthy();
    client.close();

    // Fork via HTTP
    const forkRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/fork`,
      payload: { branchName: "to-merge" },
    });
    expect(forkRes.statusCode).toBe(200);

    const childId = forkRes.json().session.id;
    const childSession = sessionManager.get(childId);
    const childDir = childSession!.workspaceDir!;

    // Make changes in the child session
    fs.writeFileSync(path.join(childDir, "feature.txt"), "new feature");
    const childGit = new GitManager(childDir);
    await childGit.autoCommit("Add feature");

    // Merge the child into the parent via HTTP
    const mergeRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/git/merge`,
      payload: { sourceSessionId: childId },
    });
    expect(mergeRes.statusCode).toBe(200);
    const body = mergeRes.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("to-merge");

    // Verify the file exists in the parent
    const parentSession = sessionManager.get(parentId);
    expect(parentSession).toBeDefined();
    expect(fs.existsSync(path.join(parentSession!.workspaceDir!, "feature.txt"))).toBe(true);
  }, 15_000);
});
