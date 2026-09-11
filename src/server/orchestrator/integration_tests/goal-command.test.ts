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
  let codexes: FakeGoalCodex[];
  let lastClaude: FakeClaudeProcess | null;
  let savedOpenAIKey: string | undefined;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    codexes = [];
    lastClaude = null;
    goalAnswer = { goal: null };
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-goal-"));
    sessions = new SessionManager(dbManager);

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
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      agentFactory: (agentId: AgentId) => {
        if (agentId === "codex") {
          const codex = new FakeGoalCodex();
          codexes.push(codex);
          return codex;
        }
        lastClaude = new FakeClaudeProcess();
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
    client.close();
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

  it("sends /goal to an agent without goals as an ordinary prompt (req 5)", async () => {
    const client = await TestClient.connect(port, undefined, { model: "claude-opus-5" });
    await client.receive();

    client.send({ type: "send_message", text: "/goal clear" });
    const claude = await waitForClaude(() => lastClaude!);
    expect(claude.lastPrompt).toContain("/goal clear");
    expect(codexes).toHaveLength(0);
    client.close();
  });
});
