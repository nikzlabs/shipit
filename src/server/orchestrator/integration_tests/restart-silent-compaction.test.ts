// docs/333-idle-compaction piece 4 — the worker keeps a silent compaction's class with its turn,
// so a restarted orchestrator adopts the turn as the maintenance it is, missed-card check included.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { DatabaseManager } from "../../shared/database.js";
import type { SystemTurnDeps } from "../session-runner.js";
import { MISSED_COMPACTION_NOTICE } from "../compact-before-turn.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import type {
  AgentProcess,
  AgentProcessEvents,
  AgentId,
  AgentRunParams,
  PermissionMode,
  WorkerAgentStatus,
} from "../../shared/types.js";

class FakeWorkerAgent extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "claude";
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
    supportsReview: true,
    supportsSteering: false,
    supportsCompaction: true,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };
  runCalled = false;
  lastParams: AgentRunParams | null = null;
  readonly isStreaming = false;
  readonly messages: string[] = [];

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }
  writeStdin(): void {}
  sendUserMessage(text: string): void { this.messages.push(text); }
  interrupt(): void {}
  kill(): void {}
  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } {
    return {};
  }
}

async function waitFor(fn: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

const SESSION = "idle-session";
const LONG_AGO = "2026-10-01T08:00:00.000Z";

describe("Integration: a silent compaction across an orchestrator restart (docs/333-idle-compaction)", () => {
  let worker: SessionWorker;
  let workerUrl: string;
  let lastAgent: FakeWorkerAgent;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let runners: ContainerSessionRunner[];

  beforeEach(async () => {
    lastAgent = null as unknown as FakeWorkerAgent;
    runners = [];
    worker = new SessionWorker({
      agentFactory: () => {
        lastAgent = new FakeWorkerAgent();
        return lastAgent;
      },
      port: 0,
      host: "127.0.0.1",
    });
    const address = await worker.start();
    workerUrl = `http://127.0.0.1:${Number(/:(\d+)$/.exec(address)?.[1] ?? 0)}`;
    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    sessionManager.track(SESSION, "Idle work", "/tmp/idle-session");
  });

  afterEach(async () => {
    for (const r of runners) r.dispose({ force: true });
    await worker.stop();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  function makeRunner(): ContainerSessionRunner {
    const runner = new ContainerSessionRunner({
      sessionId: SESSION,
      sessionDir: "/tmp/idle-session",
      defaultAgentId: "claude",
      workerUrl,
    });
    const deps: SystemTurnDeps = {
      agentFactory: (agentId) => runner.createAgent(agentId),
      autoCommit: async () => ({
        commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null, hookFailure: null,
      }),
      scheduleAutoPush: () => {},
      buildRunParams: async (_sessionId, _agentId, prompt, _route, opts) => ({
        prompt, cwd: "/workspace", ...(opts?.compact ? { compact: true } : {}),
      }),
      listenerDeps: {
        sessionManager,
        chatHistoryManager,
        usageManager: new UsageManager(dbManager),
        sseBroadcast: () => {},
        broadcastLog: () => {},
        getSelectedModel: () => undefined,
      },
    };
    runner.setSystemTurnDeps(deps);
    runners.push(runner);
    return runner;
  }

  const status = async () => (await (await fetch(`${workerUrl}/agent/status`)).json()) as WorkerAgentStatus;
  const post = (path: string, body: object) =>
    fetch(`${workerUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("the worker keeps the class with the turn, from a spawn and from a message, and forgets it at the end", async () => {
    expect((await post("/agent/start", {
      agentId: "claude", runToken: "t1", silentCompaction: true,
      params: { prompt: "/compact", cwd: "/workspace", compact: true },
    })).status).toBe(200);
    await waitFor(() => lastAgent?.runCalled, "the compaction spawned");
    expect((await status()).silentCompaction).toBe(true);
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-1" });
    expect((await status()).silentCompaction).toBeUndefined();

    // A resident process: the class rides the message that starts the turn.
    lastAgent.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect((await post("/agent/start", {
      agentId: "claude", runToken: "t2",
      params: { prompt: "work", cwd: "/workspace", useStreaming: true },
    })).status).toBe(200);
    await waitFor(() => lastAgent?.runCalled, "the resident spawned");
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-1" });
    expect((await status()).silentCompaction).toBeUndefined();
    expect((await post("/agent/message", { text: "/compact", silentCompaction: true })).status).toBe(200);
    expect((await status()).silentCompaction).toBe(true);
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-1" });
    expect((await status()).silentCompaction).toBeUndefined();
  });

  it("behind a turn the CLI started, keeps no mark, so no later turn inherits one", async () => {
    expect((await post("/agent/start", {
      agentId: "claude", runToken: "t1",
      params: { prompt: "work", cwd: "/workspace", useStreaming: true },
    })).status).toBe(200);
    await waitFor(() => lastAgent?.runCalled, "the resident spawned");
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-1" });
    lastAgent.emit("event", { type: "agent_self_wake", taskId: "t1", status: "completed" });
    expect((await status()).turnActive).toBe(true);

    expect((await post("/agent/message", { text: "/compact", silentCompaction: true })).status).toBe(200);
    expect((await status()).silentCompaction).toBeUndefined();
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-1" });
    // The compaction runs with no event that starts a turn here, and ends.
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-1" });

    // A turn the CLI starts on its own is not marked either.
    lastAgent.emit("event", { type: "agent_self_wake", taskId: "t2", status: "completed" });
    const own = await status();
    expect(own.turnActive).toBe(true);
    expect(own.silentCompaction).toBeUndefined();
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-1" });

    expect((await post("/agent/message", { text: "the user's next message" })).status).toBe(200);
    const next = await status();
    expect(next.turnActive).toBe(true);
    expect(next.silentCompaction).toBeUndefined();
  });

  it("the orchestrator marks the silent compaction it starts", async () => {
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "/compact", silent: true, automatic: true }));
    await waitFor(() => lastAgent?.runCalled, "the compaction spawned");
    expect(lastAgent.lastParams?.compact).toBe(true);
    expect((await status()).silentCompaction).toBe(true);
  });

  for (const withCard of [true, false]) {
    it(`a restart mid-compaction adopts it as maintenance — ${withCard ? "its card" : "the missed-card notice"}`, async () => {
      dbManager.db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(LONG_AGO, SESSION);
      sessionManager.setMuted(SESSION, LONG_AGO);
      sessionManager.setLastTurnOutcome(SESSION, "errored");
      sessionManager.setLastTurnErrored(SESSION, true);

      // The compaction the previous orchestrator started.
      expect((await post("/agent/start", {
        agentId: "claude", runToken: "pre-restart", silentCompaction: true,
        params: { prompt: "/compact", cwd: "/workspace", compact: true },
      })).status).toBe(200);
      await waitFor(() => lastAgent?.runCalled, "the compaction spawned");
      lastAgent.emit("event", { type: "agent_init", agentId: "claude", sessionId: "cli-1", tools: [] });

      const runner = makeRunner();
      expect(await runner.resumeInFlightTurn()).toBe(true);
      if (withCard) lastAgent.emit("event", { type: "agent_compacted", preTokens: 250_000, postTokens: 9_000 });
      lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-1" });
      lastAgent.emit("done", 0);
      await waitFor(() => !runner.running && !runner.postTurnWorkInFlight, "the adopted compaction ended");

      const rows = chatHistoryManager.load(SESSION);
      const notices = rows.filter((m) => m.text === MISSED_COMPACTION_NOTICE);
      if (withCard) {
        await waitFor(() => chatHistoryManager.latestCompactionCard(SESSION) !== undefined, "the card");
        expect(notices).toHaveLength(0);
      } else {
        await waitFor(
          () => chatHistoryManager.load(SESSION).some((m) => m.text === MISSED_COMPACTION_NOTICE),
          "the missed-card notice",
        );
      }
      const session = sessionManager.get(SESSION)!;
      expect(session.lastUsedAt).toBe(LONG_AGO);
      expect(session.mutedAt).toBe(LONG_AGO);
      expect(session.lastTurnOutcome).toBe("errored");
      expect(session.lastTurnErrored).toBe(true);
    });
  }
});
