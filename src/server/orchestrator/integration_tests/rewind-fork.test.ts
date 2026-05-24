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

  async function createSession(): Promise<{ sessionId: string; workspaceDir: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "Rewind test" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { sessionId: string; workspaceDir: string };
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
