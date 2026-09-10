import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import type { CredentialStore } from "../credential-store.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import { ChatHistoryManager } from "../chat-history.js";

describe("Integration: conditional history refetch (planning#324)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let history: ChatHistoryManager;
  let sessionId: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-304-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    history = new ChatHistoryManager(dbManager);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      chatHistoryManager: history,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;

    history.append(sessionId, { role: "user", text: "file a bug about the preview" });
    history.append(sessionId, {
      role: "assistant",
      text: "",
      bugReport: {
        cardId: "card-1",
        phase: "draft",
        title: "Preview will not reload",
        body: "It stays blank after a save.",
        stage2Ran: true,
        producer: "session",
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  const load = (ifNoneMatch?: string) => app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/history`,
    ...(ifNoneMatch ? { headers: { "if-none-match": ifNoneMatch } } : {}),
  });

  async function currentTag(): Promise<string> {
    const res = await load();
    expect(res.statusCode).toBe(200);
    return res.headers.etag!;
  }

  it("serves the transcript with a validator on the first load", async () => {
    const res = await load();
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBeTruthy();
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect((res.json() as { messages: { text: string }[] }).messages).toHaveLength(2);
  });

  it("answers 304 with an empty body when nothing changed", async () => {
    const etag = await currentTag();
    const again = await load(etag);
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    expect(again.headers.etag).toBe(etag);
  });

  it("moves the validator when a card is patched in place", async () => {
    const etag = await currentTag();
    const before = dbManager.db
      .prepare("SELECT COUNT(*) AS n, MAX(id) AS maxId FROM messages WHERE session_id = ?")
      .get(sessionId) as { n: number; maxId: number };

    expect(history.updateBugReportCard(sessionId, "card-1", {
      phase: "filed",
      issueNumber: 4711,
      issueUrl: "https://github.com/o/r/issues/4711",
    })).toBe(true);

    const after = dbManager.db
      .prepare("SELECT COUNT(*) AS n, MAX(id) AS maxId FROM messages WHERE session_id = ?")
      .get(sessionId) as { n: number; maxId: number };
    expect(after).toEqual(before);

    const res = await load(etag);
    expect(res.statusCode).toBe(200);
    const card = (res.json() as { messages: { bugReport?: { phase: string; issueNumber?: number } }[] })
      .messages[1].bugReport;
    expect(card?.phase).toBe("filed");
    expect(card?.issueNumber).toBe(4711);
  });

  it("moves the validator when a message is appended", async () => {
    const etag = await currentTag();
    history.append(sessionId, { role: "assistant", text: "filed it" });

    const res = await load(etag);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { messages: { text: string }[] }).messages).toHaveLength(3);
  });

  it("moves the validator when the transcript is rewritten to the same length", async () => {
    const etag = await currentTag();
    history.saveMessages(sessionId, [
      { role: "user", text: "file a bug about the preview" },
      { role: "assistant", text: "REWRITTEN" },
    ]);

    const res = await load(etag);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { messages: { text: string }[] }).messages[1].text).toBe("REWRITTEN");
  });

  it("moves the validator when a non-transcript part of the payload changes", async () => {
    const etag = await currentTag();
    const revision = history.transcriptRevision(sessionId);

    history.createRewindSnapshot(sessionId, { action: "chat", messages: [] });
    expect(history.transcriptRevision(sessionId)).toBe(revision);

    const res = await load(etag);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { rewindSnapshot: { action: string } | null }).rewindSnapshot?.action)
      .toBe("chat");
  });

  it("does not read the transcript at all to answer 304", async () => {
    const etag = await currentTag();
    const loadSpy = vi.spyOn(history, "load");

    expect((await load(etag)).statusCode).toBe(304);
    expect(loadSpy).not.toHaveBeenCalled();

    history.append(sessionId, { role: "assistant", text: "filed it" });
    expect((await load(etag)).statusCode).toBe(200);
    expect(loadSpy).toHaveBeenCalledWith(sessionId);
  });

  it("keeps one session's validator independent of another's writes", async () => {
    const etag = await currentTag();
    const other = await createTestSession(sessionManager, tmpDir);
    history.append(other.sessionId, { role: "user", text: "unrelated" });

    expect((await load(etag)).statusCode).toBe(304);
  });
});
