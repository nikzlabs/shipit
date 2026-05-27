import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { GitManager } from "../../shared/git.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: rewind and fork", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-rewind-"));
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createSession(): Promise<{ sessionId: string; sessionDir: string; workspaceDir: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "Rewind test" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { sessionId: string; sessionDir: string; workspaceDir: string };
  }

  it("returns preview counts for gap actions with notice messages ignored", async () => {
    const { sessionId } = await createSession();
    chatHistoryManager.append(sessionId, { role: "user", text: "first" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "ok" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "Code rolled back", notice: true, noticeLevel: "info" });
    chatHistoryManager.append(sessionId, { role: "user", text: "next" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_preview_request", gapPosition: 2, action: "chat" });
    await expect(client.receiveType("rewind_preview")).resolves.toMatchObject({
      type: "rewind_preview",
      gapPosition: 2,
      action: "chat",
      discardedTurnGroupCount: 1,
    });

    client.send({ type: "rewind_preview_request", gapPosition: 4, action: "fork" });
    await expect(client.receiveType("rewind_preview")).resolves.toMatchObject({
      type: "rewind_preview",
      gapPosition: 4,
      action: "fork",
      keptTurnGroupCount: 3,
    });

    client.close();
  });

  it("marks code-only rewound messages durably without appending a divider row", async () => {
    const { sessionId, workspaceDir } = await createSession();
    const git = new GitManager(workspaceDir);
    const initialHead = await git.getHeadHash();
    expect(initialHead).toBeTruthy();

    fs.writeFileSync(path.join(workspaceDir, "feature.txt"), "changed\n");
    const changedHead = await git.autoCommit("change feature");
    expect(changedHead).toBeTruthy();

    chatHistoryManager.append(sessionId, { role: "user", text: "change the file" });
    chatHistoryManager.append(sessionId, {
      role: "assistant",
      text: "changed",
      commitHash: changedHead ?? undefined,
      parentCommitHash: initialHead ?? undefined,
    });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 1, action: "code" });
    await expect(client.receiveType("rewind_complete")).resolves.toMatchObject({
      type: "rewind_complete",
      gapPosition: 1,
      action: "code",
      commitHash: initialHead,
    });

    const loaded = chatHistoryManager.load(sessionId);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].rolledBack).toBeUndefined();
    expect(loaded[1]).toMatchObject({ rolledBack: true, codeRollbackHash: initialHead });
    expect(loaded.some((m) => m.notice)).toBe(false);
    expect(await git.getHeadHash()).toBe(initialHead);

    client.close();
  });

  it("restores code-only rewind snapshots and clears stale chat markers", async () => {
    const { sessionId, workspaceDir } = await createSession();
    const git = new GitManager(workspaceDir);
    const initialHead = await git.getHeadHash();
    expect(initialHead).toBeTruthy();

    fs.writeFileSync(path.join(workspaceDir, "feature.txt"), "changed\n");
    const changedHead = await git.autoCommit("change feature");
    expect(changedHead).toBeTruthy();

    chatHistoryManager.append(sessionId, { role: "user", text: "change the file" });
    chatHistoryManager.append(sessionId, {
      role: "assistant",
      text: "changed",
      commitHash: changedHead ?? undefined,
      parentCommitHash: initialHead ?? undefined,
    });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 1, action: "code" });
    await expect(client.receiveType("rewind_complete")).resolves.toMatchObject({
      type: "rewind_complete",
      action: "code",
      snapshotSessionId: sessionId,
    });
    expect(await git.getHeadHash()).toBe(initialHead);
    expect(chatHistoryManager.load(sessionId)[1]).toMatchObject({ rolledBack: true, codeRollbackHash: initialHead });

    client.send({ type: "rewind_restore_request", sessionId });
    await expect(client.receiveType("rewind_restored")).resolves.toMatchObject({
      type: "rewind_restored",
      sessionId,
      action: "code",
    });
    expect(await git.getHeadHash()).toBe(changedHead);
    expect(chatHistoryManager.load(sessionId)[1].rolledBack).toBeUndefined();
    expect(chatHistoryManager.load(sessionId)[1].codeRollbackHash).toBeUndefined();

    client.close();
  });

  it("truncates chat-only rewinds and removes uploads from discarded messages", async () => {
    const { sessionId, sessionDir } = await createSession();
    const uploadsDir = path.join(sessionDir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, "discarded.txt"), "uploaded\n");

    chatHistoryManager.append(sessionId, { role: "user", text: "keep" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "kept response" });
    chatHistoryManager.append(sessionId, {
      role: "user",
      text: "discard",
      files: [{ path: "/uploads/discarded.txt", contentPreview: "uploaded" }],
      uploadPaths: ["/uploads/discarded.txt"],
    });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "chat" });
    await expect(client.receiveType("rewind_complete")).resolves.toMatchObject({
      type: "rewind_complete",
      gapPosition: 2,
      action: "chat",
      droppedMessageCount: 1,
    });

    expect(chatHistoryManager.load(sessionId).map((m) => m.text)).toEqual(["keep", "kept response"]);
    expect(fs.existsSync(path.join(uploadsDir, "discarded.txt"))).toBe(false);

    client.close();
  });

  it("stores a chat rewind snapshot and restores it on request", async () => {
    const { sessionId } = await createSession();
    chatHistoryManager.append(sessionId, { role: "user", text: "keep" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "kept response" });
    chatHistoryManager.append(sessionId, { role: "user", text: "restore me" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "chat" });
    await expect(client.receiveType("rewind_complete")).resolves.toMatchObject({
      type: "rewind_complete",
      action: "chat",
      snapshotSessionId: sessionId,
    });
    expect(chatHistoryManager.load(sessionId).map((m) => m.text)).toEqual(["keep", "kept response"]);

    client.send({ type: "rewind_restore_request", sessionId });
    await expect(client.receiveType("rewind_restored")).resolves.toMatchObject({
      type: "rewind_restored",
      sessionId,
      action: "chat",
    });
    expect(chatHistoryManager.load(sessionId).map((m) => m.text)).toEqual(["keep", "kept response", "restore me"]);

    client.close();
  });

  it("rewinds code and chat while persisting the rollback notice at the kept boundary", async () => {
    const { sessionId, workspaceDir } = await createSession();
    const git = new GitManager(workspaceDir);
    const initialHead = await git.getHeadHash();
    expect(initialHead).toBeTruthy();

    fs.writeFileSync(path.join(workspaceDir, "feature.txt"), "changed\n");
    const changedHead = await git.autoCommit("change feature");
    expect(changedHead).toBeTruthy();

    chatHistoryManager.append(sessionId, { role: "user", text: "change the file" });
    chatHistoryManager.append(sessionId, {
      role: "assistant",
      text: "changed",
      commitHash: changedHead ?? undefined,
      parentCommitHash: initialHead ?? undefined,
    });
    chatHistoryManager.append(sessionId, { role: "user", text: "discard this follow-up" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 1, action: "both" });
    await expect(client.receiveType("rewind_complete")).resolves.toMatchObject({
      type: "rewind_complete",
      gapPosition: 1,
      action: "both",
      droppedMessageCount: 2,
      commitHash: initialHead,
    });

    const loaded = chatHistoryManager.load(sessionId);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ role: "user", text: "change the file" });
    expect(loaded[1]).toMatchObject({
      role: "assistant",
      notice: true,
      noticeLevel: "info",
      text: expect.stringContaining(initialHead!.slice(0, 7)),
    });
    expect(await git.getHeadHash()).toBe(initialHead);

    client.close();
  });

  it("rewinds chat when 'both' is requested but no code commits exist", async () => {
    const { sessionId, workspaceDir } = await createSession();
    const git = new GitManager(workspaceDir);
    const initialHead = await git.getHeadHash();
    expect(initialHead).toBeTruthy();

    // No autoCommit calls — every message lacks commitHash and parentCommitHash,
    // so findCommitBeforeGap returns null. Used to fail the action entirely;
    // now degrades to chat-only.
    chatHistoryManager.append(sessionId, { role: "user", text: "first message" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "first reply" });
    chatHistoryManager.append(sessionId, { role: "user", text: "discard me" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "also discard" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "both" });
    await expect(client.receiveType("rewind_complete")).resolves.toMatchObject({
      type: "rewind_complete",
      gapPosition: 2,
      action: "both",
      droppedMessageCount: 2,
    });

    const loaded = chatHistoryManager.load(sessionId);
    expect(loaded.map((m) => m.text)).toEqual(["first message", "first reply"]);
    expect(await git.getHeadHash()).toBe(initialHead);

    client.close();
  });

  it("forks from a gap, copies kept uploads, and persists the parent breadcrumb", async () => {
    const { sessionId, sessionDir } = await createSession();
    const uploadsDir = path.join(sessionDir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, "kept.txt"), "kept upload\n");

    chatHistoryManager.append(sessionId, {
      role: "user",
      text: "keep upload",
      files: [{ path: "/uploads/kept.txt", contentPreview: "kept upload" }],
      uploadPaths: ["/uploads/kept.txt"],
    });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "kept response" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "fork", sessionName: "Kept upload" });
    const forked = await client.receiveType("session_forked");
    expect(forked).toMatchObject({
      type: "session_forked",
      parentSessionId: sessionId,
      title: "Kept upload",
    });
    if (forked.type !== "session_forked") throw new Error("Expected session_forked");

    const child = sessionManager.get(forked.childSessionId);
    expect(child?.title).toBe("Kept upload");
    expect(child?.branch).toBeTruthy();
    expect(chatHistoryManager.load(forked.childSessionId).map((m) => m.text)).toEqual(["keep upload", "kept response"]);
    expect(child?.workspaceDir).toBeTruthy();
    expect(fs.existsSync(path.join(path.dirname(child!.workspaceDir!), "uploads", "kept.txt"))).toBe(true);

    const parentMessages = chatHistoryManager.load(sessionId);
    expect(parentMessages.at(-1)).toMatchObject({
      forkChild: {
        childSessionId: forked.childSessionId,
        title: child?.title,
        branch: child?.branch,
      },
    });

    client.close();
  });

  it("restores fork snapshots by archiving the child and removing the parent breadcrumb", async () => {
    const { sessionId } = await createSession();
    chatHistoryManager.append(sessionId, { role: "user", text: "keep" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "kept response" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "fork", sessionName: "Undo fork" });
    const forked = await client.receiveType("session_forked");
    expect(forked).toMatchObject({
      type: "session_forked",
      parentSessionId: sessionId,
      snapshotSessionId: sessionId,
    });
    if (forked.type !== "session_forked") throw new Error("Expected session_forked");
    expect(chatHistoryManager.load(sessionId).at(-1)?.forkChild?.childSessionId).toBe(forked.childSessionId);

    client.send({ type: "rewind_restore_request", sessionId });
    await expect(client.receiveType("rewind_restored")).resolves.toMatchObject({
      type: "rewind_restored",
      sessionId,
      action: "fork",
      archivedSessionId: forked.childSessionId,
    });
    expect(sessionManager.get(forked.childSessionId)?.archived).toBe(true);
    expect(chatHistoryManager.load(sessionId).some((m) => m.forkChild?.childSessionId === forked.childSessionId)).toBe(false);

    client.close();
  });

  it("rejects rewind while a turn is running", async () => {
    const { sessionId } = await createSession();
    chatHistoryManager.append(sessionId, { role: "user", text: "keep" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "kept response" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    const runningRes = await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      payload: { running: true },
    });
    expect(runningRes.statusCode).toBe(200);

    client.send({ type: "rewind_at_gap", gapPosition: 1, action: "chat" });
    await expect(client.receiveType("error")).resolves.toMatchObject({
      type: "error",
      message: "Cannot rewind while a turn is running.",
    });
    expect(chatHistoryManager.load(sessionId)).toHaveLength(2);

    client.close();
  });

  it("clears queued messages when a rewind succeeds", async () => {
    const { sessionId } = await createSession();
    chatHistoryManager.append(sessionId, { role: "user", text: "keep" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "kept response" });
    chatHistoryManager.append(sessionId, { role: "user", text: "discard" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    const runningRes = await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      payload: { running: true },
    });
    expect(runningRes.statusCode).toBe(200);

    client.send({ type: "send_message", text: "queued prompt", sessionId });
    await expect(client.receiveType("message_queued")).resolves.toMatchObject({
      type: "message_queued",
      text: "queued prompt",
    });

    const idleRes = await app.inject({
      method: "POST",
      url: `/api/_test/runner/${sessionId}/running`,
      payload: { running: false },
    });
    expect(idleRes.statusCode).toBe(200);

    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "chat" });
    await expect(client.receiveType("system_notice")).resolves.toMatchObject({
      type: "system_notice",
      message: "Cleared 1 queued message as part of rewind.",
      level: "info",
    });
    await expect(client.receiveType("rewind_complete")).resolves.toMatchObject({
      type: "rewind_complete",
      action: "chat",
      gapPosition: 2,
    });

    const runnerRes = await app.inject({
      method: "GET",
      url: `/api/_test/runner/${sessionId}`,
    });
    expect(runnerRes.statusCode).toBe(200);
    expect(runnerRes.json()).toMatchObject({ queueLength: 0 });

    client.close();
  });

  it("rejects non-fork rewind at the current-state gap", async () => {
    const { sessionId } = await createSession();
    chatHistoryManager.append(sessionId, { role: "user", text: "only message" });

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");

    client.send({ type: "rewind_at_gap", gapPosition: 1, action: "chat" });
    await expect(client.receiveType("error")).resolves.toMatchObject({
      type: "error",
      message: "Nothing to rewind from the current state.",
    });
    expect(chatHistoryManager.load(sessionId)).toHaveLength(1);

    client.close();
  });
});
