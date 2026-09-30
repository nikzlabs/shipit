import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import type { WsSessionMessageProposalUpdate, WsSystemUserMessage } from "../../shared/types.js";

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
  let agents: FakeClaudeProcess[];

  beforeEach(async () => {
    agents = [];
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deliver-session-message-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        agents.push(agent);
        return agent as unknown as never;
      },
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    // The app's own manager, not a second one over the same file: a test that
    // stubs a write must intercept the instance the route actually calls.
    chatHistory = app.chatHistoryManager;

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

  const decline = (cardId: string) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/session-message-proposals/${cardId}/decline`,
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

  /**
   * The card's "queued" line is read off the DISPATCH's own admission, not
   * guessed from whether the target was running: a running, steerable target
   * takes the message immediately, so "Queued behind…" would be a lie.
   */
  it("reports an idle target's delivery as not queued", async () => {
    const cardId = await propose("Report.");
    const res = await deliver(cardId);
    expect(res.json()).toMatchObject({ queued: false });

    const persisted = chatHistory.findSessionMessageProposalCard(sessionId, cardId);
    expect(persisted?.queued).toBe(false);
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

  /**
   * req 5 — dispatch is the point of no return. If persisting the delivered
   * state throws AFTER the message has landed, marking the card `failed` would
   * offer a "Try again" that delivers it a second time.
   */
  it("never marks a card retryable once the message has been dispatched", async () => {
    const cardId = await propose("Exactly once.");
    const targetClient = await TestClient.connect(port, targetId);
    await targetClient.receive();

    const realUpdate = chatHistory.updateSessionMessageProposalCard.bind(chatHistory);
    let calls = 0;
    chatHistory.updateSessionMessageProposalCard = ((sid, cid, patch) => {
      calls += 1;
      // The first call is `delivering`; fail the terminal one, after dispatch.
      if (calls > 1) throw new Error("simulated persistence failure");
      return realUpdate(sid, cid, patch);
    }) as typeof chatHistory.updateSessionMessageProposalCard;

    const res = await deliver(cardId);
    chatHistory.updateSessionMessageProposalCard = realUpdate;

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ delivered: true });
    // The viewer is still told it landed, though the card could not store it.
    const seen = await client.drain({ quietMs: 200 });
    expect(seen.some((m) => m.type === "session_message_proposal_update"
      && (m as WsSessionMessageProposalUpdate).state === "delivered")).toBe(true);

    // The message really did land, and the card was not downgraded to `failed`.
    const arrived = (await targetClient.receiveType("system_user_message")) as WsSystemUserMessage;
    expect(arrived.text).toBe("Exactly once.");
    targetClient.close();
    expect(chatHistory.findSessionMessageProposalCard(sessionId, cardId)?.state)
      .not.toBe("failed");

    // The stored card still reads `delivering`; neither a second send nor a
    // decline may act on a message that already landed.
    expect((await deliver(cardId)).statusCode).toBe(409);
    expect((await decline(cardId)).statusCode).toBe(409);
  });

  it("refuses to deliver a card the user declined, and sends nothing", async () => {
    const cardId = await propose("Never mind.");
    expect((await decline(cardId)).statusCode).toBe(200);
    const targetClient = await TestClient.connect(port, targetId);
    await targetClient.receive();

    const res = await deliver(cardId);
    expect(res.statusCode).toBe(409);
    expect(chatHistory.findSessionMessageProposalCard(sessionId, cardId)?.state).toBe("declined");
    const seen = await targetClient.drain({ quietMs: 200 });
    expect(seen.some((m) => m.type === "system_user_message")).toBe(false);
    targetClient.close();
  });

  // req 13.
  describe("declining the message", () => {
    it("records the decline on the card and tells the viewer", async () => {
      const cardId = await propose("Not this one.");

      const res = await decline(cardId);
      expect(res.statusCode).toBe(200);
      const { declinedAt } = res.json() as { declinedAt: string };
      expect(declinedAt).toBeTruthy();

      const update = (await client.receiveType("session_message_proposal_update")) as WsSessionMessageProposalUpdate;
      expect(update).toMatchObject({ cardId, state: "declined", declinedAt });
      expect(chatHistory.findSessionMessageProposalCard(sessionId, cardId)).toMatchObject({
        state: "declined",
        declinedAt,
      });
    });

    it("declines a card whose delivery failed, and clears the failure", async () => {
      const cardId = await propose("Retry or not.");
      chatHistory.updateSessionMessageProposalCard(sessionId, cardId, { state: "failed", errorMessage: "boom" });

      expect((await decline(cardId)).statusCode).toBe(200);
      const card = chatHistory.findSessionMessageProposalCard(sessionId, cardId);
      expect(card?.state).toBe("declined");
      expect(card?.errorMessage).toBeUndefined();
    });

    it("answers a second decline with the first one's time", async () => {
      const cardId = await propose("Twice.");
      const first = (await decline(cardId)).json() as { declinedAt: string };
      const second = await decline(cardId);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ declinedAt: first.declinedAt });
    });

    it("refuses to decline a message that was already delivered", async () => {
      const cardId = await propose("Already there.");
      expect((await deliver(cardId)).statusCode).toBe(200);

      const res = await decline(cardId);
      expect(res.statusCode).toBe(409);
      expect(chatHistory.findSessionMessageProposalCard(sessionId, cardId)?.state).toBe("delivered");
    });

    it("404s for a card that is not in this session's history", async () => {
      expect((await decline("session-message-nope")).statusCode).toBe(404);
    });

    it("tells the viewer nothing when the decline could not be stored", async () => {
      const cardId = await propose("Unstorable.");
      await client.drain({ quietMs: 100 });
      const write = vi
        .spyOn(chatHistory, "updateSessionMessageProposalCard")
        .mockImplementation(() => { throw new Error("disk full"); });

      try {
        expect((await decline(cardId)).statusCode).toBe(500);
        const seen = await client.drain({ quietMs: 200 });
        expect(seen.some((m) => m.type === "session_message_proposal_update")).toBe(false);
      } finally {
        write.mockRestore();
      }
      expect(chatHistory.findSessionMessageProposalCard(sessionId, cardId)?.state).toBeUndefined();
    });
  });

  // req 14, through the WebSocket send path (`agent-execution.ts`).
  describe("telling the proposing agent", () => {
    /** Send a user turn, let the agent answer it, and return the prompt it was given. */
    async function answeredTurn(text: string): Promise<string> {
      const before = agents.length;
      client.send({ type: "send_message", text });
      const deadline = Date.now() + 5000;
      for (;;) {
        const agent = agents[before];
        if (agent?.runCalled) {
          agent.emit("event", { type: "result", subtype: "success", session_id: "agent-sid" });
          agent.emit("done", 0);
          await new Promise((r) => setTimeout(r, 50));
          return agent.lastPrompt;
        }
        if (Date.now() > deadline) throw new Error(`no agent ran for ${JSON.stringify(text)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    it("tells the next turn that the user declined, once", async () => {
      const cardId = await propose("Maybe later.");
      await decline(cardId);

      const first = await answeredTurn("What next?");
      expect(first).toContain("[ShipIt] Since your last turn, the user acted on a card you posted");
      expect(first).toContain(`session ${targetId} "Orchestrator" — DECLINED by the user`);
      expect(first.endsWith("What next?")).toBe(true);

      const second = await answeredTurn("And now?");
      expect(second).not.toContain("[ShipIt] Since your last turn");
    });

    it("tells the next turn that the message was delivered", async () => {
      const cardId = await propose("Done.");
      chatHistory.updateSessionMessageProposalCard(sessionId, cardId, { state: "delivered", queued: false });

      const prompt = await answeredTurn("Carry on");
      expect(prompt).toContain("DELIVERED by the user; it started a turn there.");
    });

    it("says nothing about a card the user has not acted on", async () => {
      await propose("Pending.");
      const prompt = await answeredTurn("Carry on");
      expect(prompt).not.toContain("[ShipIt] Since your last turn");
    });
  });
});
