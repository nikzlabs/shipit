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
import type { WsSessionMessageProposalCard } from "../../shared/types.js";
import { MAX_PROPOSED_MESSAGE_LEN } from "../../shared/session-message-proposal-validation.js";

/**
 * docs/314 — every refusal here happens at CALL time (req 8), so an agent that
 * got the address wrong learns while it can still fix it.
 */
describe("Integration: propose-session-message route", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let chatHistory: ChatHistoryManager;
  let sessionId: string;
  let rootId: string;
  let client: TestClient;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "propose-session-message-"));
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

    sessionId = (await createTestSession(sessionManager, tmpDir, "Proposer")).sessionId;
    rootId = (await createTestSession(sessionManager, tmpDir, "Orchestrator")).sessionId;

    // The route needs an active runner, as `propose-repo-session` does.
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

  const propose = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/propose-session-message`,
      payload,
    });

  it("emits a card naming the target session, and persists it", async () => {
    const message = "Branch shipit/bsnu-9 is green; PR #1 is open.";
    const res = await propose({ sessionId: rootId, message });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, targetTitle: "Orchestrator" });

    const emitted = (await client.receiveType(
      "session_message_proposal_card",
    )) as WsSessionMessageProposalCard;
    expect(emitted.card).toMatchObject({
      targetSessionId: rootId,
      targetTitle: "Orchestrator",
      message,
    });
    // Nothing is delivered by proposing (req 7).
    expect(emitted.card.state).toBeUndefined();

    const persisted = chatHistory.findSessionMessageProposalCard(sessionId, emitted.card.cardId);
    expect(persisted).toMatchObject({ targetSessionId: rootId, message });
  });

  it("proposes for a SIBLING, not only a root session", async () => {
    const parentId = (await createTestSession(sessionManager, tmpDir, "Coordinator")).sessionId;
    sessionManager.setParentSession(sessionId, parentId);
    const siblingId = (await createTestSession(sessionManager, tmpDir, "Sibling")).sessionId;
    sessionManager.setParentSession(siblingId, parentId);

    const res = await propose({ sessionId: siblingId, message: "Done with the parser slice." });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ targetTitle: "Sibling" });
  });

  it("refuses an id no session on this host has", async () => {
    const res = await propose({ sessionId: "00000000-0000-4000-8000-000000000000", message: "hi" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("No session on this host");
  });

  it("refuses the proposing session itself", async () => {
    const res = await propose({ sessionId, message: "hi" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("That is this session");
  });

  // req 9 — a target `shipit session message` already reaches is not a proposal.
  it("refuses a direct child and names the direct route", async () => {
    const childId = (await createTestSession(sessionManager, tmpDir, "Child")).sessionId;
    sessionManager.setParentSession(childId, sessionId);

    const res = await propose({ sessionId: childId, message: "hi" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(`shipit session message ${childId}`);
  });

  it("refuses an archived target, rather than letting the user click into a failure", async () => {
    sessionManager.archive(rootId);
    const res = await propose({ sessionId: rootId, message: "hi" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("archived");
  });

  it("refuses a warm-pool session, which is not work the user is following", async () => {
    sessionManager.setWarm(rootId, true);
    const res = await propose({ sessionId: rootId, message: "hi" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("warm pool");
  });

  it("refuses a message over the cap", async () => {
    const res = await propose({ sessionId: rootId, message: "x".repeat(MAX_PROPOSED_MESSAGE_LEN + 1) });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a proposal with no message", async () => {
    const res = await propose({ sessionId: rootId });
    expect(res.statusCode).toBe(400);
  });

  // req 7 — the agent can reach the propose route and not the deliver route,
  // so approval is the only way anything is delivered.
  it("exposes propose to a session container and never deliver", () => {
    const routes = [...app.containerAccessibleRoutes];
    expect(routes).toContain("POST /api/sessions/:sessionId/propose-session-message");
    expect(routes.some((r) => r.includes("session-message-proposals"))).toBe(false);
  });
});
