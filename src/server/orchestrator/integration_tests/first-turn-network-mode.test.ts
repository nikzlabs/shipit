/**
 * docs/285 — the two ways a message could start a turn beside an in-flight
 * first Send, and the guarantee that neither does.
 *
 * A session's first turn is CLAIMED from before its network-mode reconciliation
 * until the turn is dispatched, because the reconciliation destroys the container
 * and builds a replacement — seconds, not microseconds, and the replacement
 * resolves its containment later still. Everything that starts a turn has to
 * respect that claim.
 *
 * `dispatch()` does, and `session-runner.test.ts` guards it. This file guards the
 * OTHER path: `handleSendMessage` sets `running` and calls `runAgentWithMessage`
 * directly, without going through `dispatch()` at all, so it inherits nothing
 * from that check. A review found the resulting bypass, and it is invisible to a
 * dispatcher-level test by construction — the code under test never calls the
 * dispatcher.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  waitFor,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
  flushStartupTasks,
} from "./test-helpers.js";
import {
  claimFirstTurn,
  _resetFirstTurnAdmission,
} from "../services/first-turn-admission.js";

describe("Integration: a claimed first turn is not raced (docs/285)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let allClaudes: FakeClaudeProcess[];
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;

  beforeEach(async () => {
    _resetFirstTurnAdmission();
    dbManager = createTestDatabaseManager();
    allClaudes = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-first-turn-network-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      credentialStore,
      credentialsDir: path.join(tmpDir, "credentials"),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const proc = new FakeClaudeProcess();
        allClaudes.push(proc);
        return proc as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    _resetFirstTurnAdmission();
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("queues a send that arrives while ANOTHER handler owns the first turn", async () => {
    const { sessionId } = await createTestSession(sessionManager, tmpDir, "Claimed");

    // Exactly the state an in-flight first Send leaves behind: the session-scoped
    // claim is held while its container is rebuilt for the picked network mode.
    // Held here directly rather than by racing two real sockets, because the
    // window being guarded is a container restart — seconds of real time this
    // harness has no container to spend.
    const release = claimFirstTurn(sessionId)!;

    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "second message" });

    // It must be QUEUED, not run. The claim's whole purpose is that the network
    // mode this session's first turn resolves is not decided twice.
    const queued = await client.receiveType("message_queued", 5000);
    expect(queued).toMatchObject({ text: "second message", position: 1 });
    // No agent was spawned: the bypass this guards would have started one.
    expect(allClaudes.length).toBe(0);

    release();
  }, 20000);

  it("runs the send normally once the claim is released", async () => {
    // The control. Without it the test above passes for the wrong reason — a
    // fixture that cannot start a turn at all would queue whatever the guard
    // does, and the assertion would prove nothing about the claim.
    const { sessionId } = await createTestSession(sessionManager, tmpDir, "Unclaimed");

    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "first message" });

    await waitForClaude(() => allClaudes[0] ?? null, null, 5000);
    expect(allClaudes.length).toBe(1);
  }, 20000);

  it("keeps the claim's own message running rather than queueing it behind itself", async () => {
    // The guard tests "someone ELSE owns it", and the difference matters: a
    // check on the claim's presence alone would make every first Send hand its
    // own message off to a queue nobody drains. The claim is taken by
    // `handleSendMessage` at entry for a WARM session, so this drives the real
    // warm path instead of holding a claim by hand.
    const { sessionId } = await createTestSession(sessionManager, tmpDir, "Warm");
    // The startup sweep deletes an ungraduated warm session that no repo's warm
    // pool registers. Let it run BEFORE marking this one warm, or it takes the
    // session out from under the test.
    await flushStartupTasks();
    sessionManager.setWarm(sessionId, true);

    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "the first message" });

    await waitForClaude(() => allClaudes[0] ?? null, null, 5000);
    expect(allClaudes.length).toBe(1);
    // …and the claim did not leak: graduation ran, so the session is no longer warm.
    await waitFor(() => sessionManager.get(sessionId)?.warm !== true, "graduation", 5000);
  }, 20000);
});
