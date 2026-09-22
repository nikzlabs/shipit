import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import type { WsSystemUserMessage } from "../../shared/types.js";

/**
 * docs/314 — the user's click is the delivery. `shipit session message` cannot
 * reach a root session or a sibling; approving a card does, and nothing else.
 */
describe("Integration: session-message proposal delivery", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let chatHistory: ChatHistoryManager;
  let sessionId: string;
  let targetId: string;
  let client: TestClient;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deliver-session-message-"));
    sessionManager = new SessionManager(dbManager);
    chatHistory = new ChatHistoryManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    sessionId = (await createTestSession(sessionManager, tmpDir, "Reporter")).sessionId;
    targetId = (await createTestSession(sessionManager, tmpDir, "Orchestrator")).sessionId;

    client = await TestClient.connect(port, sessionId);
    await client.receive();
  });

  afterEach(async () => {
    client?.close();
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  async function propose(message: string, target = targetId): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/propose-session-message`,
      payload: { sessionId: target, message },
    });
    expect(res.statusCode).toBe(200);
    return res.json().cardId as string;
  }

  const deliver = (cardId: string) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/session-message-proposals/${cardId}/deliver`,
    });

  it("starts a turn in a ROOT session, which `session message` cannot reach", async () => {
    const message = "docs/314 is implemented; PR is open.";
    const cardId = await propose(message);

    // `shipit session message` refuses the same target: it is nobody's child.
    const direct = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/children/${targetId}/message`,
      payload: { text: message },
    });
    expect(direct.statusCode).toBe(404);

    const targetClient = await TestClient.connect(port, targetId);
    await targetClient.receive();

    const res = await deliver(cardId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const arrived = (await targetClient.receiveType("system_user_message")) as WsSystemUserMessage;
    expect(arrived.text).toBe(message);
    // req 6 — the receiving session is told where this came from.
    expect(arrived.messageOrigin).toEqual({
      sessionId,
      sessionTitle: "Reporter",
      relation: "proposed",
    });
    targetClient.close();

    const persisted = chatHistory.findSessionMessageProposalCard(sessionId, cardId);
    expect(persisted?.state).toBe("delivered");
  });

  it("reaches a SIBLING, not only a root session", async () => {
    const parentId = (await createTestSession(sessionManager, tmpDir, "Coordinator")).sessionId;
    sessionManager.setParentSession(sessionId, parentId);
    const siblingId = (await createTestSession(sessionManager, tmpDir, "Sibling")).sessionId;
    sessionManager.setParentSession(siblingId, parentId);

    const cardId = await propose("Parser slice done.", siblingId);
    const siblingClient = await TestClient.connect(port, siblingId);
    await siblingClient.receive();

    expect((await deliver(cardId)).statusCode).toBe(200);

    const arrived = (await siblingClient.receiveType("system_user_message")) as WsSystemUserMessage;
    expect(arrived.text).toBe("Parser slice done.");
    siblingClient.close();
  });

  // req 5 — approval delivers once; it is not a standing channel.
  it("refuses a second delivery of the same card", async () => {
    const cardId = await propose("Once.");
    expect((await deliver(cardId)).statusCode).toBe(200);

    const again = await deliver(cardId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain("already delivered");
  });

  it("fails the card, not silently, when the target is archived after the proposal", async () => {
    const cardId = await propose("Too late.");
    sessionManager.archive(targetId);

    const res = await deliver(cardId);
    expect(res.statusCode).toBe(400);

    const persisted = chatHistory.findSessionMessageProposalCard(sessionId, cardId);
    expect(persisted?.state).toBe("failed");
    expect(persisted?.errorMessage).toContain("archived");
  });

  it("404s a card id this session's history does not hold", async () => {
    const res = await deliver("session-message-nope");
    expect(res.statusCode).toBe(404);
  });
});
