import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  StubGitHubAuthManager,
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
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess() as unknown as FakeClaudeProcess;
        return lastClaude as unknown as ClaudeProcess;
      },
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

  it("fork_session creates a worktree session via HTTP", async () => {
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

  // ---- list_worktrees ----

  it("list_worktrees returns 404 for nonexistent session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent/worktrees" });
    expect(res.statusCode).toBe(404);
  });

  it("list_worktrees returns worktrees for active session (standalone)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await createAndActivateSession(client, "Parent");

    // For standalone sessions (no remoteUrl), list_worktrees returns only the active session
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/worktrees` });
    expect(res.statusCode).toBe(200);
    // Standalone session has no branch, so worktrees list is filtered to entries with branch
    const worktrees = res.json().worktrees;
    expect(worktrees.length).toBe(0);

    client.close();
  });

  // ---- archive_session with worktree ----

  it("archive_session cleans up worktree when archiving child session", async () => {
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

    // The worktree directory should have been removed
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

  it("merge_session merges a worktree branch into the parent session via HTTP", async () => {
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

    // Make changes in the child worktree
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

// ---------------------------------------------------------------------------
// Transparent worktree reuse in home_send_with_repo
// ---------------------------------------------------------------------------

describe("Integration: home_send_with_repo worktree reuse", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess | null;
  let githubAuthManager: StubGitHubAuthManager;

  /** Create a bare git repo that can be cloned locally via file:// URL. */
  function createBareRepo(): string {
    const bareDir = path.join(tmpDir, "bare-remote.git");
    fs.mkdirSync(bareDir, { recursive: true });
    execSync("git init --bare -b main", { cwd: bareDir, stdio: "ignore" });

    const workTree = path.join(tmpDir, "bare-work");
    fs.mkdirSync(workTree, { recursive: true });
    execSync("git init -b main", { cwd: workTree, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: workTree, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: workTree, stdio: "ignore" });
    execSync("git config commit.gpgsign false", { cwd: workTree, stdio: "ignore" });
    fs.writeFileSync(path.join(workTree, "README.md"), "# Test Repo\n");
    execSync("git add .", { cwd: workTree, stdio: "ignore" });
    execSync("git commit -m 'initial commit'", { cwd: workTree, stdio: "ignore" });
    try { execSync("git branch -M main", { cwd: workTree, stdio: "ignore" }); } catch { /* ok */ }
    execSync(`git remote add origin ${bareDir}`, { cwd: workTree, stdio: "ignore" });
    execSync("git push origin main", { cwd: workTree, stdio: "ignore" });
    // Set bare repo HEAD to main so clones check out files
    execSync("git symbolic-ref HEAD refs/heads/main", { cwd: bareDir, stdio: "ignore" });

    return bareDir;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-worktree-reuse-"));
    lastClaude = null;

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);
    githubAuthManager = new StubGitHubAuthManager();

    app = await buildApp({
      createGitManager: (dir: string) => {
        const gm = new GitManager(dir);
        // Stub renameBranch to avoid race with async session naming
        gm.renameBranch = async () => { /* no-op in tests */ };
        // Stub clone for non-local URLs
        const origClone = gm.clone.bind(gm);
        gm.clone = async (url: string, branch?: string) => {
          if (url.startsWith("file://") || url.startsWith("/")) {
            return origClone(url, branch);
          }
          throw new Error(`clone failed: repository '${url}' not found`);
        };
        return gm;
      },
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess() as unknown as FakeClaudeProcess;
        return lastClaude as unknown as ClaudeProcess;
      },
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

  it("second home_send_with_repo for same repo creates worktree instead of cloning", async () => {
    const bareRepoPath = createBareRepo();
    const repoUrl = `file://${bareRepoPath}`;

    // --- First request: full clone ---
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "home_send_with_repo", repoUrl, text: "First session" } as any);

    const session1Msg = await client1.receiveSkipLogs(10_000);
    expect(session1Msg.type).toBe("session_started");
    const session1 = (session1Msg as any).session;

    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();

    // Drain remaining messages
    try { while (true) { await client1.receive(500); } } catch { /* done */ }
    client1.close();

    // All sessions are worktrees from the shared repo clone
    const firstSession = sessionManager.get(session1.id);
    expect(firstSession).toBeDefined();
    expect(firstSession!.remoteUrl).toBe(repoUrl);
    expect(firstSession!.sessionType).toBe("worktree");
    expect(firstSession!.branch).toBeTruthy();

    // --- Second request: same repo URL should also be a worktree ---
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    client2.send({ type: "home_send_with_repo", repoUrl, text: "Second session" } as any);

    const session2Msg = await client2.receiveSkipLogs(10_000);
    expect(session2Msg.type).toBe("session_started");
    const session2 = (session2Msg as any).session;

    const claude2 = await waitForClaude(() => lastClaude, claude1, 10_000);
    claude2.finish();

    // Drain remaining messages
    try { while (true) { await client2.receive(300); } } catch { /* done */ }
    client2.close();

    // Verify second session is also a worktree
    const secondSession = sessionManager.get(session2.id);
    expect(secondSession).toBeDefined();
    expect(secondSession!.sessionType).toBe("worktree");
    expect(secondSession!.branch).toBeTruthy();
    expect(secondSession!.remoteUrl).toBe(repoUrl);
    // Different branches
    expect(secondSession!.branch).not.toBe(firstSession!.branch);

    // Verify the worktree directory exists and has the repo files
    expect(fs.existsSync(path.join(secondSession!.workspaceDir!, "README.md"))).toBe(true);

    // Verify both share the same shared repo dir (not cloned twice)
    const reposDir = path.join(tmpDir, "repos");
    const repoDirs = fs.readdirSync(reposDir);
    expect(repoDirs.length).toBe(1); // only one shared clone
  }, 15_000);

  it("worktree session changes are independent from parent", async () => {
    const bareRepoPath = createBareRepo();
    const repoUrl = `file://${bareRepoPath}`;

    // First request: full clone
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status
    client1.send({ type: "home_send_with_repo", repoUrl, text: "First" } as any);

    // Drain until session_started
    let session1Id = "";
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();
    try {
      while (true) {
        const msg = await client1.receive(500);
        if (msg.type === "session_started") session1Id = (msg as any).session.id;
      }
    } catch { /* done */ }
    client1.close();

    // Fallback: get from session manager
    if (!session1Id) {
      const sessions = sessionManager.list();
      if (sessions.length > 0) session1Id = sessions[0].id;
    }

    // Second request: worktree
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status
    client2.send({ type: "home_send_with_repo", repoUrl, text: "Second" } as any);

    let session2Id = "";
    const claude2 = await waitForClaude(() => lastClaude, claude1, 10_000);
    claude2.finish();
    try {
      while (true) {
        const msg = await client2.receive(500);
        if (msg.type === "session_started") session2Id = (msg as any).session.id;
      }
    } catch { /* done */ }
    client2.close();

    if (!session2Id) {
      const sessions = sessionManager.list();
      session2Id = sessions.find((s) => s.id !== session1Id)?.id ?? "";
    }

    // Write a file in the worktree session
    const session2 = sessionManager.get(session2Id)!;
    fs.writeFileSync(path.join(session2.workspaceDir!, "new-file.txt"), "worktree only");

    // Parent should NOT have the file
    const session1 = sessionManager.get(session1Id)!;
    expect(fs.existsSync(path.join(session1.workspaceDir!, "new-file.txt"))).toBe(false);
  }, 15_000);

  // ---- Edge case: missing worktree on session resume ----

  /** Wait for a session_started message, skipping other messages. */
  async function waitForSessionStarted(client: TestClient, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await client.receive(deadline - Date.now());
      if (msg.type === "session_started") return msg;
    }
    throw new Error("Timed out waiting for session_started");
  }

  it("send_message returns error when worktree directory is missing", async () => {
    const bareRepoPath = createBareRepo();
    const repoUrl = `file://${bareRepoPath}`;

    // Create a worktree session via home_send_with_repo
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "home_send_with_repo", repoUrl, text: "My session" } as any);

    const sessionMsg = await waitForSessionStarted(client);
    const session = sessionMsg.session;

    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();
    try { while (true) { await client.receive(300); } } catch { /* drain */ }
    client.close();

    // Verify it's a worktree session
    const sessionInfo = sessionManager.get(session.id)!;
    expect(sessionInfo.sessionType).toBe("worktree");

    // Delete the worktree directory to simulate it going missing
    fs.rmSync(sessionInfo.workspaceDir!, { recursive: true, force: true });

    // Try to send a message to this session — should get graceful error
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    client2.send({ type: "send_message", text: "hello", sessionId: session.id });

    // Wait for the worktree-missing error (skip other messages)
    const deadline = Date.now() + 5000;
    let errorMsg: any = null;
    while (Date.now() < deadline && !errorMsg) {
      const msg = await client2.receive(deadline - Date.now());
      if (msg.type === "error" && (msg as any).message?.includes("workspace")) {
        errorMsg = msg;
      }
    }
    expect(errorMsg).not.toBeNull();
    expect(errorMsg.message).toContain("workspace is no longer available");

    client2.close();
  }, 15_000);

  it("HTTP history returns data even when worktree directory is missing", async () => {
    const bareRepoPath = createBareRepo();
    const repoUrl = `file://${bareRepoPath}`;

    // Create a worktree session
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "home_send_with_repo", repoUrl, text: "My session" } as any);

    const sessionMsg = await waitForSessionStarted(client);
    const session = sessionMsg.session;

    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();
    try { while (true) { await client.receive(300); } } catch { /* drain */ }
    client.close();

    const sessionInfo = sessionManager.get(session.id)!;
    expect(sessionInfo.sessionType).toBe("worktree");

    // Delete the worktree directory
    fs.rmSync(sessionInfo.workspaceDir!, { recursive: true, force: true });

    // Load chat history via HTTP — should return 200 with empty file tree/git log
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/history`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toBeDefined();
    expect(body.fileTree).toEqual([]);
    expect(body.commits).toEqual([]);
  }, 15_000);

  // ---- Edge case: shared repo cleanup ----

  it("shared repo is cleaned up when all sessions for it are archived", async () => {
    const bareRepoPath = createBareRepo();
    const repoUrl = `file://${bareRepoPath}`;

    // Create first worktree session
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "home_send_with_repo", repoUrl, text: "First" } as any);
    const s1Msg = await client1.receiveSkipLogs(10_000);
    expect(s1Msg.type).toBe("session_started");
    const session1Id = (s1Msg as any).session.id;

    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();
    try { while (true) { await client1.receive(500); } } catch { /* drain */ }
    client1.close();

    // Create second worktree session
    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status

    client2.send({ type: "home_send_with_repo", repoUrl, text: "Second" } as any);
    const s2Msg = await client2.receiveSkipLogs(10_000);
    expect(s2Msg.type).toBe("session_started");
    const session2Id = (s2Msg as any).session.id;

    const claude2 = await waitForClaude(() => lastClaude, claude1, 10_000);
    claude2.finish();
    try { while (true) { await client2.receive(500); } } catch { /* drain */ }
    client2.close();

    // Verify shared repo exists
    const reposDir = path.join(tmpDir, "repos");
    expect(fs.existsSync(reposDir)).toBe(true);
    const repoDirs = fs.readdirSync(reposDir);
    expect(repoDirs.length).toBe(1);
    const sharedRepoDir = path.join(reposDir, repoDirs[0]);

    // Archive first session via HTTP — shared repo should still exist (one session remains)
    const archiveRes1 = await app.inject({ method: "DELETE", url: `/api/sessions/${session1Id}` });
    expect(archiveRes1.statusCode).toBe(200);

    expect(fs.existsSync(sharedRepoDir)).toBe(true);

    // Archive second session via HTTP — now shared repo should be cleaned up
    const archiveRes2 = await app.inject({ method: "DELETE", url: `/api/sessions/${session2Id}` });
    expect(archiveRes2.statusCode).toBe(200);

    expect(fs.existsSync(sharedRepoDir)).toBe(false);
  }, 20_000);

  it("shared repo is NOT cleaned up when other sessions still use it", async () => {
    const bareRepoPath = createBareRepo();
    const repoUrl = `file://${bareRepoPath}`;

    // Create two sessions
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status
    client1.send({ type: "home_send_with_repo", repoUrl, text: "First" } as any);
    const s1Msg = await client1.receiveSkipLogs(10_000);
    const session1Id = (s1Msg as any).session.id;
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();
    try { while (true) { await client1.receive(500); } } catch { /* drain */ }
    client1.close();

    const client2 = await TestClient.connect(port);
    await client2.receive(); // preview_status
    client2.send({ type: "home_send_with_repo", repoUrl, text: "Second" } as any);
    const s2Msg = await client2.receiveSkipLogs(10_000);
    expect(s2Msg.type).toBe("session_started");
    const claude2 = await waitForClaude(() => lastClaude, claude1, 10_000);
    claude2.finish();
    try { while (true) { await client2.receive(500); } } catch { /* drain */ }
    client2.close();

    // Archive only the first session via HTTP
    const archiveRes = await app.inject({ method: "DELETE", url: `/api/sessions/${session1Id}` });
    expect(archiveRes.statusCode).toBe(200);

    // Shared repo should still exist
    const reposDir = path.join(tmpDir, "repos");
    const repoDirs = fs.readdirSync(reposDir);
    expect(repoDirs.length).toBe(1);
    const sharedRepoDir = path.join(reposDir, repoDirs[0]);
    expect(fs.existsSync(sharedRepoDir)).toBe(true);
  }, 15_000);
});
