import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import type { SessionStatus } from "../../shared/types.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

/**
 * docs/303 req 17 — an offer is taken when the message the user composed from it
 * is ACCEPTED. The queue can still refuse one, so the acceptance sits after the
 * dispatch on every path; before it, a refused message greyed the offer out for
 * work that never reached the agent.
 */
describe("Integration: session status offers are taken on acceptance", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;
  let lastClaude: FakeClaudeProcess = null as never;

  const card = (): SessionStatus => ({
    status: "Routes done",
    fresh: true,
    writeSeq: 1, turnSeq: 0,
    actions: [
      { id: "wire", offerId: "o1", label: "Wire it", payload: "Wire it", offeredAt: "2026-09-14T10:00:00.000Z" },
    ],
  });

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-offer-accept-"));
    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* cleanup only */ }
  });

  async function startTurnWithStoredCard(client: TestClient): Promise<string> {
    client.send({ type: "send_message", text: "first" });
    await waitForClaude(() => lastClaude);
    const sessionId = sessionManager.list()[0].id;
    sessionManager.setSessionStatus(sessionId, card());
    return sessionId;
  }

  /** The frame the handler answers with; receiving it proves the send was processed. */
  async function waitFor(client: TestClient, type: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const msg = await client.receive(5000);
      if (msg.type === type) return;
    }
    throw new Error(`no ${type} frame arrived`);
  }

  function takenAt(sessionId: string): string | undefined {
    return sessionManager.get(sessionId)?.sessionStatus?.actions[0].takenAt;
  }

  it("marks an offer taken once the queue accepts the message", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = await startTurnWithStoredCard(client);

    client.send({ type: "send_message", text: "Wire it", sessionStatusOfferIds: ["o1"] });
    await waitFor(client, "message_queued");
    // The mark is a chained serialized write, so it settles on a later tick.
    for (let i = 0; i < 100 && !takenAt(sessionId); i++) await new Promise((r) => setTimeout(r, 10));

    expect(takenAt(sessionId)).toBeTruthy();
    client.close();
  });

  it("marks nothing when the full queue refuses the message", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = await startTurnWithStoredCard(client);

    for (let i = 0; i < 50; i++) {
      client.send({ type: "send_message", text: `filler ${i}` });
      await waitFor(client, "message_queued");
    }

    client.send({ type: "send_message", text: "Wire it", sessionStatusOfferIds: ["o1"] });
    // The refusal is what the handler answers with once the queue is full.
    await waitFor(client, "error");
    await new Promise((r) => setTimeout(r, 50));

    expect(takenAt(sessionId)).toBeUndefined();
    client.close();
  });
});
