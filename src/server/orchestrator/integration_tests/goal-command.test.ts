import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { AgentRegistry, CODEX_TOOL_NAMES } from "../../shared/agent-registry.js";
import type { FastifyInstance } from "fastify";
import type {
  AgentCapabilities,
  AgentGoal,
  AgentGoalCommand,
  AgentGoalCommandResult,
  AgentId,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
  WsServerMessage,
} from "../../shared/types.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";

const GOAL: AgentGoal = {
  objective: "Make the suite green",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  updatedAt: 1,
};

let goalAnswer: AgentGoalCommandResult = { goal: null };

// docs/297 — Claude Code answers `get` and `clear` from a control process; a
// `set` never reaches the adapter, so this fake would record one if it did.
let claudeGoalAnswer: AgentGoalCommandResult = { goal: null };
let claudeGoalCalls: { threadId: string; command: AgentGoalCommand }[] = [];

class FakeGoalClaude extends FakeClaudeProcess {
  goalCommand(threadId: string, command: AgentGoalCommand): Promise<AgentGoalCommandResult> {
    claudeGoalCalls.push({ threadId, command });
    return Promise.resolve(claudeGoalAnswer);
  }
}

class FakeGoalCodex extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "codex";
  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: [...CODEX_TOOL_NAMES],
    models: [],
    supportsReview: false,
    supportsSteering: false,
    supportsCompaction: false,
    supportsGoals: true,
    skillsDirName: ".codex",
    skillInvocationPrefix: "$",
  };
  readonly isStreaming = false;
  runCalled = false;
  lastParams: AgentRunParams | null = null;
  goalCalls: { threadId: string; command: AgentGoalCommand }[] = [];

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }
  writeStdin(): void {}
  sendUserMessage(): void {}
  interrupt(): void {}
  kill(): void {}
  writeMcpConfig(): Record<string, never> {
    return {};
  }
  goalCommand(threadId: string, command: AgentGoalCommand): Promise<AgentGoalCommandResult> {
    this.goalCalls.push({ threadId, command });
    return Promise.resolve(goalAnswer);
  }
  finish(threadId: string): void {
    this.emit("event", { type: "agent_result", status: "success", sessionId: threadId });
    this.emit("done", 0);
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function receiveNotice(client: TestClient, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const msg = await client.receive(Math.max(1, deadline - Date.now())) as WsServerMessage;
    if (msg.type === "system_notice") return msg.message;
  }
}

describe("Integration: /goal (docs/154)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessions: SessionManager;
  let chatHistory: ChatHistoryManager;
  let codexes: FakeGoalCodex[];
  let lastClaude: FakeClaudeProcess | null;
  let savedOpenAIKey: string | undefined;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    codexes = [];
    lastClaude = null;
    goalAnswer = { goal: null };
    claudeGoalAnswer = { goal: null };
    claudeGoalCalls = [];
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-goal-"));
    sessions = new SessionManager(dbManager);
    chatHistory = new ChatHistoryManager(dbManager);

    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "claude" || binary === "codex",
      checkClaudeAuth: () => true,
    });
    await registry.detect();
    process.env.OPENAI_API_KEY = "test-key-for-codex";
    registry.refreshAuth("codex");

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: sessions,
      chatHistoryManager: chatHistory,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      agentFactory: (agentId: AgentId) => {
        if (agentId === "codex") {
          const codex = new FakeGoalCodex();
          codexes.push(codex);
          return codex;
        }
        lastClaude = new FakeGoalClaude();
        return lastClaude as unknown as AgentProcess;
      },
      defaultAgentId: "codex" as AgentId,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** One ordinary turn, so the session has a Codex thread to hold a goal. */
  async function runTurn(client: TestClient, during?: (turn: FakeGoalCodex) => void): Promise<void> {
    client.send({ type: "send_message", text: "Work on it" });
    await waitUntil(() => codexes.some((c) => c.runCalled));
    const turn = codexes.find((c) => c.runCalled)!;
    during?.(turn);
    turn.finish("thread-1");
    await waitUntil(() => sessions.get(client.sessionId)?.agentSessionId === "thread-1");
  }

  it("shows a goal the model created, then clears it without a turn (reqs 1, 2, 4)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    await runTurn(client, (turn) => { turn.emit("event", { type: "agent_goal_updated", goal: GOAL }); });
    await waitUntil(() => sessions.get(client.sessionId)?.agentGoal?.objective === GOAL.objective);

    client.send({ type: "send_message", text: "/goal clear" });
    expect(await receiveNotice(client)).toBe("Goal cleared.");

    const answered = codexes.filter((c) => c.goalCalls.length > 0);
    expect(answered).toHaveLength(1);
    expect(answered[0].goalCalls).toEqual([{ threadId: "thread-1", command: { action: "clear" } }]);
    expect(codexes.filter((c) => c.runCalled)).toHaveLength(1);
    expect(sessions.get(client.sessionId)?.agentGoal).toBeUndefined();
    // The command has no bubble; its notice is what a reload shows.
    await waitUntil(() => chatHistory.load(client.sessionId).some((m) => m.notice && m.text === "Goal cleared."));
    client.close();
  });

  it("reads a never-read goal when the session is opened, once, without a turn (req 6)", async () => {
    // A session from before this feature: it has a Codex thread but its goal was never read.
    const first = await TestClient.connect(port);
    await first.receive();
    const sessionId = first.sessionId;
    first.close();
    sessions.setAgentSessionId(sessionId, "thread-old");
    goalAnswer = { goal: GOAL };

    const client = await TestClient.connect(port, sessionId);
    await client.receive();
    await waitUntil(() => sessions.get(sessionId)?.agentGoal?.objective === GOAL.objective);
    expect(codexes.flatMap((c) => c.goalCalls)).toEqual([{ threadId: "thread-old", command: { action: "get" } }]);
    expect(codexes.some((c) => c.runCalled)).toBe(false);
    client.close();

    const again = await TestClient.connect(port, sessionId);
    await again.receive();
    await new Promise((r) => setTimeout(r, 100));
    expect(codexes.flatMap((c) => c.goalCalls)).toHaveLength(1);
    again.close();
  });

  it("sets a goal and keeps it on the session (reqs 3, 6)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    await runTurn(client);

    goalAnswer = { goal: GOAL };
    client.send({ type: "send_message", text: "/goal Make the suite green" });
    expect(await receiveNotice(client)).toBe("Goal set: Make the suite green");
    expect(codexes.flatMap((c) => c.goalCalls)).toEqual([
      { threadId: "thread-1", command: { action: "set", objective: "Make the suite green" } },
    ]);
    expect(sessions.get(client.sessionId)?.agentGoal).toEqual(GOAL);
    client.close();
  });

  it("asks for a first message when there is no conversation yet", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "/goal ship it" });
    expect(await receiveNotice(client)).toMatch(/first message/);
    expect(codexes).toHaveLength(0);
    client.close();
  });

  it("keeps the full vocabulary for Codex (docs/297 req 8)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    await runTurn(client);

    goalAnswer = { goal: GOAL };
    for (const text of ["/goal", "/goal pause", "/goal resume"]) {
      client.send({ type: "send_message", text });
      await receiveNotice(client);
    }
    expect(codexes.flatMap((c) => c.goalCalls).map((c) => c.command.action))
      .toEqual(["get", "pause", "resume"]);
    // Every one was answered out of band; none became a turn.
    expect(codexes.filter((c) => c.runCalled)).toHaveLength(1);
    client.close();
  });

  describe("Claude Code (docs/297)", () => {
    /** Give the session a Claude thread, the way a first turn does. */
    async function claudeSession(): Promise<TestClient> {
      const client = await TestClient.connect(port, undefined, { model: "claude-opus-5" });
      await client.receive();
      client.send({ type: "send_message", text: "Work on it" });
      const claude = await waitForClaude(() => lastClaude);
      claude.emit("event", { type: "result", subtype: "success", session_id: "claude-thread" });
      claude.emit("done", 0);
      await waitUntil(() => sessions.get(client.sessionId)?.agentSessionId === "claude-thread");
      return client;
    }

    it("lets /goal <objective> ride the turn, verbatim (reqs 1, 7)", async () => {
      const client = await claudeSession();
      const first = lastClaude;
      // A notice would otherwise be prepended, which stops the CLI reading the
      // line as a command at all; context appended would become the objective.
      sessions.setPendingAgentNotice(client.sessionId, "A previous PR was merged.");

      client.send({ type: "send_message", text: "/goal the suite is green" });
      const claude = await waitForClaude(() => lastClaude, first);

      expect(claude.lastPrompt).toBe("/goal the suite is green");
      // The notice was not eaten by the command; it rides the next ordinary turn.
      expect(sessions.consumePendingAgentNotice(client.sessionId)).toBe("A previous PR was merged.");
      // Only the read-on-open reached the adapter; a set out of band would be CLI
      // work with no ShipIt turn behind it.
      expect(claudeGoalCalls.map((c) => c.command.action)).not.toContain("set");
      client.close();
    });

    it("re-reads the goal after the turn, so one the CLI met silently disappears (req 2)", async () => {
      const client = await claudeSession();
      const first = lastClaude;
      claudeGoalCalls = [];

      client.send({ type: "send_message", text: "/goal the suite is green" });
      const claude = await waitForClaude(() => lastClaude, first);
      // What the adapter reports from the CLI's set acknowledgement (unit-tested
      // in claude/adapter.test.ts); ShipIt shows the goal from that alone.
      claude.emit("event", {
        type: "agent_goal_updated",
        goal: { ...GOAL, objective: "the suite is green" },
      });
      await waitUntil(() => sessions.get(client.sessionId)?.agentGoal?.objective === "the suite is green");

      // The turn ends with the condition met, which the CLI clears without a word.
      claudeGoalAnswer = { goal: null };
      claude.emit("event", { type: "result", subtype: "success", session_id: "claude-thread" });
      claude.emit("done", 0);

      await waitUntil(() => sessions.get(client.sessionId)?.agentGoal === undefined, 8000);
      expect(claudeGoalCalls.map((c) => c.command.action)).toContain("get");
      client.close();
    });

    it("answers /goal and /goal clear out of band (req 3)", async () => {
      const client = await claudeSession();
      claudeGoalAnswer = { goal: GOAL };

      client.send({ type: "send_message", text: "/goal" });
      expect(await receiveNotice(client)).toBe("Goal (active): Make the suite green");

      claudeGoalAnswer = { goal: null };
      client.send({ type: "send_message", text: "/goal clear" });
      expect(await receiveNotice(client)).toBe("Goal cleared.");

      expect(claudeGoalCalls.map((c) => c.command)).toEqual([{ action: "get" }, { action: "clear" }]);
      client.close();
    });

    it("refuses a /goal that carries attachments rather than folding them into the objective", async () => {
      const client = await claudeSession();
      const first = lastClaude;

      client.send({
        type: "send_message",
        text: "/goal the suite is green",
        images: [{ data: "aGk=", mediaType: "image/png" }],
      });
      expect(await receiveNotice(client)).toMatch(/cannot carry attachments/);

      // Measured: an appended context block lands inside the condition, so the
      // message must not reach the CLI at all.
      expect(lastClaude).toBe(first);
      client.close();
    });

    it("refuses an action Claude Code does not have, and never sends the keyword on (req 4)", async () => {
      const client = await claudeSession();
      const first = lastClaude;

      client.send({ type: "send_message", text: "/goal pause" });
      expect(await receiveNotice(client)).toBe(
        "Claude Code has no goal pause. Use `/goal clear` to remove the goal.",
      );

      // Measured: the CLI's clear keywords are `clear stop off reset none cancel`,
      // so an un-refused `/goal pause` sets a goal literally named "pause".
      expect(claudeGoalCalls).toEqual([]);
      expect(lastClaude).toBe(first);
      client.close();
    });

  });
});
