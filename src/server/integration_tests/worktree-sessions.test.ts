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
    expect(forkedMsg.session.branch).toBe("feature-1");
    expect(forkedMsg.session.sessionType).toBe("worktree");
    expect(forkedMsg.parentSessionId).toBe(parentId);

    // Verify the worktree directory exists
    expect(fs.existsSync(forkedMsg.session.workspaceDir)).toBe(true);

    client.close();
  }, 15_000);

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

  it("list_worktrees returns worktrees for active session (standalone)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createAndActivateSession(client, "Parent");

    // For standalone sessions (no remoteUrl), list_worktrees returns only the active session
    client.send({ type: "list_worktrees" } as any);
    const msg = await client.receive();

    expect(msg.type).toBe("worktree_list");
    // Standalone session has no branch, so worktrees list is filtered to entries with branch
    const worktrees = (msg as any).worktrees;
    expect(worktrees.length).toBe(0);

    client.close();
  });

  // ---- archive_session with worktree ----

  it("archive_session cleans up worktree when archiving child session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    await createAndActivateSession(client, "Parent");

    // Fork it
    client.send({ type: "fork_session", branchName: "to-archive" } as any);

    // Collect both session_forked and session_list from fork (skip any interleaved messages)
    let forkedMsg: any = null;
    let forkListReceived = false;
    const forkDeadline = Date.now() + 5000;
    while (Date.now() < forkDeadline && (!forkedMsg || !forkListReceived)) {
      const msg = await client.receive();
      if (msg.type === "session_forked") forkedMsg = msg;
      if (msg.type === "session_list") forkListReceived = true;
    }
    expect(forkedMsg).not.toBeNull();

    const childId = forkedMsg.session.id;
    const childDir = forkedMsg.session.workspaceDir;

    // Archive the child
    client.send({ type: "archive_session", sessionId: childId });

    // Wait for session_list response from archive (skip any interleaved messages)
    const archiveDeadline = Date.now() + 5000;
    let listMsg: any = null;
    while (Date.now() < archiveDeadline && !listMsg) {
      const msg = await client.receive();
      if (msg.type === "session_list") listMsg = msg;
    }
    expect(listMsg).not.toBeNull();

    // The child session should be archived
    const child = sessionManager.get(childId);
    expect(child?.archived).toBe(true);

    // The worktree directory should have been removed
    expect(fs.existsSync(childDir)).toBe(false);

    client.close();
  }, 15_000);

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

    // Collect both session_forked and session_list from fork (skip any interleaved messages)
    let forkedMsg: any = null;
    let forkListReceived = false;
    const forkDeadline = Date.now() + 5000;
    while (Date.now() < forkDeadline && (!forkedMsg || !forkListReceived)) {
      const msg = await client.receive();
      if (msg.type === "session_forked") forkedMsg = msg;
      if (msg.type === "session_list") forkListReceived = true;
    }
    expect(forkedMsg).not.toBeNull();

    const childId = forkedMsg.session.id;
    const childDir = forkedMsg.session.workspaceDir;

    // Make changes in the child worktree
    fs.writeFileSync(path.join(childDir, "feature.txt"), "new feature");
    const childGit = new GitManager(childDir);
    await childGit.autoCommit("Add feature");

    // Merge the child into the parent (parent is still active)
    client.send({ type: "merge_session", sourceSessionId: childId } as any);

    // Wait for merge_result (skip any interleaved messages)
    let mergeMsg: any = null;
    const mergeDeadline = Date.now() + 5000;
    while (Date.now() < mergeDeadline && !mergeMsg) {
      const msg = await client.receive();
      if (msg.type === "merge_result") mergeMsg = msg;
    }
    expect(mergeMsg).not.toBeNull();
    expect(mergeMsg.success).toBe(true);
    expect(mergeMsg.message).toContain("to-merge");

    // Verify the file exists in the parent
    const parentSession = sessionManager.get(parentId);
    expect(parentSession).toBeDefined();
    expect(fs.existsSync(path.join(parentSession!.workspaceDir!, "feature.txt"))).toBe(true);

    client.close();
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
    execSync("git init --bare", { cwd: bareDir, stdio: "ignore" });

    const workTree = path.join(tmpDir, "bare-work");
    fs.mkdirSync(workTree, { recursive: true });
    execSync("git init", { cwd: workTree, stdio: "ignore" });
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

    const session1Msg = await client1.receiveSkipLogs();
    expect(session1Msg.type).toBe("session_started");
    const session1 = (session1Msg as any).session;

    const claude1 = await waitForClaude(() => lastClaude);
    claude1.finish();

    // Drain remaining messages
    try { while (true) { await client1.receive(300); } } catch { /* done */ }
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

    const session2Msg = await client2.receiveSkipLogs();
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
});
