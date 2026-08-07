/**
 * A message STEERED into a running turn must refill the sub-agent spawn budget.
 *
 * The budget (`shipit agent run`, cap 3) is named and documented as per-turn,
 * but it was refilled in exactly one place: `resetRunnerTurnState`, which only
 * runs when an orchestrator turn STARTS. Live steering (docs/140) deliberately
 * does not start one — a message typed while the agent is mid-turn is injected
 * into that turn — so on the steer path the budget had no refill point at all.
 *
 * In a session where the agent is usually busy (the ordinary shape once it
 * backgrounds a consult, which is exactly what ShipIt's guidance tells it to
 * do) every message the user typed kept drawing on the budget of whichever turn
 * happened to be running. Once three spawns landed, every later `shipit agent
 * run` was refused with "Sub-agent spawn cap reached for this turn (max 3)" —
 * on a turn the user experiences as brand new.
 *
 * The two halves pinned here:
 *   1. A user-typed steered message refills the budget. Human keystrokes are
 *      not agent-emittable, so this cannot be used to top up the cap.
 *   2. A background task finishing MID-turn refills nothing, and still does not
 *      touch the transcript accumulator. `agent_self_wake` rides the CLI's
 *      `task_notification`, which any `Bash(run_in_background)` job emits — so
 *      refilling there WOULD hand the agent an unbounded cap, and resetting the
 *      accumulator there destroys chat history (`self-wake-midturn.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";
import { SUB_AGENT_PER_TURN_CAP } from "../services/sub-agent.js";

describe("Integration: sub-agent spawn budget vs live steering", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;
  let chatHistoryManager: ChatHistoryManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-budget-steer-"));
    credentialStore = createTestCredentialStore(tmpDir);
    // Live steering on — the whole point of this suite is the steer path.
    credentialStore.setLiveSteering(true);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: (chatHistoryManager = new ChatHistoryManager(dbManager)),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as never;
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
    } catch { /* ignore cleanup errors */ }
  });

  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it("refills the budget when the user steers a message into a running turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Review this with codex" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("steer-budget-session");
    await client.receiveType("session_started");

    const runner = app.runnerRegistry.get(sessionId)!;
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    // The turn spends its whole budget on consults and keeps working — the CLI
    // turn has NOT ended, so the user's next message is steered, not queued.
    runner.subAgentSpawnsThisTurn = SUB_AGENT_PER_TURN_CAP;
    expect(runner.running).toBe(true);

    client.send({ type: "send_message", text: "Now get a second opinion too" });
    await settle();

    // The message really was steered (not queued behind a new turn) …
    expect(lastClaude.stdinData.some((m) => m.includes("second opinion"))).toBe(true);
    // … and it refilled the budget, so the new instruction can spawn.
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    client.close();
  });

  it("does not refill the budget when a background task finishes mid-turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Background the consult" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("midturn-budget-session");
    await client.receiveType("session_started");

    const runner = app.runnerRegistry.get(sessionId)!;
    runner.subAgentSpawnsThisTurn = SUB_AGENT_PER_TURN_CAP;

    // A tool-result boundary persists the turn's opening.
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "GROUP-ONE" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "shipit agent run", run_in_background: true } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "started" }] },
    });
    await settle();

    // The job reports back while the same turn is still streaming. This is
    // agent-triggerable, so it must buy the agent nothing.
    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      summary: "consult finished",
      status: "completed",
    });
    await settle();

    expect(runner.subAgentSpawnsThisTurn).toBe(SUB_AGENT_PER_TURN_CAP);
    // And the running turn's chat history is intact (docs/237's invariant,
    // restated here so a future budget change can't reach for
    // `resetRunnerTurnState` on this path).
    expect(chatHistoryManager.load(sessionId).map((m) => m.text))
      .toEqual(["Background the consult", "GROUP-ONE"]);

    client.close();
  });

  it("refills the budget for a genuinely self-woken turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Background the consult" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("wake-budget-session");
    await client.receiveType("session_started");

    const runner = app.runnerRegistry.get(sessionId)!;
    runner.subAgentSpawnsThisTurn = SUB_AGENT_PER_TURN_CAP;

    // The turn ends, then the backgrounded job wakes the CLI: a turn nobody
    // started, which `resetRunnerTurnState` already covers via its
    // `!runner.running` branch. Pinned so a future change to the refill points
    // cannot silently drop it.
    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "wake-budget-session" });
    await settle(250);
    lastClaude.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      summary: "consult finished",
      status: "completed",
    });
    await settle();

    expect(runner.running).toBe(true);
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    client.close();
  });
});
