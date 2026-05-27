/**
 * Integration test for the dispatched-turn vs WS-turn race.
 *
 * Background: every turn flow — WS `send_message`, system-dispatched
 * (`runner.dispatch`), rebase resolution — competes for the runner's single
 * `_agent` slot. The SSE relay routes incoming `agent_event` from the worker
 * to whatever process is currently in that slot; if a concurrent flow has
 * replaced the slot, the original turn's events are silently dropped with
 * `[sse-drop] agent_event type=… dropped (no _agent)` — exactly the symptom
 * a Fix CI click produced in prod when the user also had a WS message
 * in flight.
 *
 * Two structural fixes guard this:
 *  1. `dispatch()` flips `running=true` synchronously before scheduling the
 *     async dispatched turn, so a concurrent WS `send_message` sees
 *     `running=true` and enqueues instead of starting a competing turn.
 *  2. The done/auth_required/error handlers in `dispatched-turn.ts`,
 *     `agent-listeners.ts`, `send-message.ts`, and `services/rebase-driver.ts`
 *     identity-guard `setAgent(null)` — they only clear the slot if it still
 *     points at the agent whose handler is firing. A later turn's agent
 *     can no longer be clobbered to null by an older turn's exit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { DatabaseManager } from "../../shared/database.js";

import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

type AnyMsg = Record<string, unknown> & { type: string };

describe("Integration: dispatched turn vs WS turn race", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess | null = null;
  let allClaudes: FakeClaudeProcess[] = [];
  let dbManager: DatabaseManager;
  let stubAuth: StubAuthManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null;
    allClaudes = [];
    stubAuth = new StubAuthManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-race-"));

    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: stubAuth as unknown as AuthManager,
      agentFactory: () => {
        const claude = new FakeClaudeProcess();
        lastClaude = claude;
        allClaudes.push(claude);
        return claude as any;
      },
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
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function drainUntil(
    client: TestClient,
    predicate: (m: AnyMsg) => boolean,
    maxMsgs = 30,
    timeoutMs = 2000,
  ): Promise<AnyMsg | null> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg = (await client.receive(timeoutMs)) as AnyMsg;
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("dispatched turn's agent receives events emitted on its own process", async () => {
    // Baseline: the dispatch path wires events through to the agent it
    // created. Without identity-guarded setAgent(null) in dispatched-turn's
    // done handler, a later turn's setAgent(NEW) is clobbered the moment
    // this turn exits — but the symptom in prod was the *current* dispatched
    // agent's events dropping, so this baseline ensures the happy path still
    // delivers events.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "[ci-fix] mock", activity: "Auto-fixing CI…" },
    });
    expect(res.statusCode).toBe(200);

    const dispatchedAgent = await waitForClaude(() => lastClaude);

    const sawInit = new Promise<boolean>((resolve) => {
      dispatchedAgent.on("event", (event: { type?: string }) => {
        if (event.type === "agent_init") resolve(true);
      });
      setTimeout(() => resolve(false), 1000);
    });
    const sawAssistant = new Promise<boolean>((resolve) => {
      dispatchedAgent.on("event", (event: { type?: string }) => {
        if (event.type === "agent_assistant") resolve(true);
      });
      setTimeout(() => resolve(false), 1000);
    });

    dispatchedAgent.emit("event", { type: "system", subtype: "init", session_id: "agent-session-dispatch" });
    dispatchedAgent.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Working on it." }] },
    });

    expect(await sawInit).toBe(true);
    expect(await sawAssistant).toBe(true);

    client.close();
  });

  it("concurrent WS send_message can NOT clobber an active dispatched turn's agent slot", async () => {
    // Repro for the prod bug: triggerCIFix → runner.dispatch races with a WS
    // send_message arriving in the same microtask. Without the synchronous
    // `running=true` flip in dispatch(), the WS handler sees `running=false`,
    // falls through to runAgentWithMessage, and overwrites the runner's
    // `_agent` slot — silently dropping every event from the dispatched
    // agent.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Fire the dispatch (HTTP) and a WS send_message immediately, in the same
    // microtask. The HTTP dispatch handler awaits triggerCIFix → runner.dispatch,
    // which now flips running=true synchronously; the WS send_message arrives
    // next and should observe running=true and enqueue.
    const dispatchPromise = app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "[ci-fix] dispatched prompt" },
    });
    client.send({ type: "send_message", text: "concurrent ws" });

    const dispatchRes = await dispatchPromise;
    expect(dispatchRes.statusCode).toBe(200);

    // The dispatched agent is the FIRST claude spawned.
    const dispatchedAgent = await waitForClaude(() => lastClaude);
    expect(dispatchedAgent.lastPrompt).toBe("[ci-fix] dispatched prompt");

    // The WS message should have been queued (not started a competing turn).
    // We assert this two ways:
    //   1. message_queued broadcast arrives for the WS text.
    //   2. No second FakeClaudeProcess gets spawned while the dispatched
    //      turn is still active.
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ type: "message_queued", text: "concurrent ws" });

    // Confirm only ONE agent has been created so far.
    expect(allClaudes.length).toBe(1);
    expect(allClaudes[0]).toBe(dispatchedAgent);

    // Now have the dispatched agent emit events — they should all reach
    // *this* agent's event listener (the SSE relay would route to
    // runner._agent, which still points here).
    const receivedEventTypes: string[] = [];
    dispatchedAgent.on("event", (event: { type?: string }) => {
      if (event.type) receivedEventTypes.push(event.type);
    });

    dispatchedAgent.emit("event", { type: "system", subtype: "init", session_id: "s-dispatched" });
    dispatchedAgent.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Fixing the CI issue." }] },
    });

    expect(receivedEventTypes).toContain("agent_init");
    expect(receivedEventTypes).toContain("agent_assistant");

    client.close();
  });

  it("a stale done handler from a prior turn does NOT clear a later turn's agent slot", async () => {
    // Identity-guard regression: when a dispatched turn finishes (process
    // exits), its done handler used to call `runner.setAgent(null)`
    // unconditionally. If a fresh turn had already been queued and started
    // (filling the slot with a NEW agent), the old handler would null the
    // new agent's slot — and every subsequent SSE event would be dropped
    // with `[sse-drop] ... no _agent`. Identity-guarding the done handler
    // (only clear if `runner.getAgent() === agent`) prevents this.
    const client = await TestClient.connect(port);
    await client.receive();

    // Start a first dispatched turn.
    const firstRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "first" },
    });
    expect(firstRes.statusCode).toBe(200);
    const firstAgent = await waitForClaude(() => lastClaude);

    // Drain the system_user_message for "first" so it doesn't interleave with
    // queued/started messages from the second turn.
    await drainUntil(client, (m) => m.type === "system_user_message");

    // Queue a second turn while the first is still running.
    const secondRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "second" },
    });
    expect(secondRes.statusCode).toBe(200);
    expect(secondRes.json()).toMatchObject({ ok: true, queued: true });

    // Confirm queued broadcast.
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ text: "second" });

    // Finish the first turn — its done handler runs after the second turn's
    // agent has already been spawned and pinned into runner._agent. With the
    // identity-guard, that handler won't null out the second turn's slot.
    firstAgent.finish("s-first");

    // Wait for the second agent to spawn (the queue drain in
    // dispatched-turn's done handler kicks off the next turn).
    const secondAgent = await waitForClaude(() => lastClaude, firstAgent);
    expect(secondAgent.lastPrompt).toBe("second");
    expect(secondAgent).not.toBe(firstAgent);

    // Now stage the canonical SSE-drop repro: emit events on the SECOND
    // agent. Before the fix, the first agent's done handler (which ran
    // moments ago) would have nulled runner._agent, and any orchestrator-
    // side code reading runner.getAgent() would see null — proxying that to
    // the SSE relay's drop branch.
    const captured: string[] = [];
    secondAgent.on("event", (event: { type?: string }) => {
      if (event.type) captured.push(event.type);
    });

    secondAgent.emit("event", { type: "system", subtype: "init", session_id: "s-second" });
    secondAgent.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Second turn working." }] },
    });

    expect(captured).toContain("agent_init");
    expect(captured).toContain("agent_assistant");

    client.close();
  });
});
