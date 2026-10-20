import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { DatabaseManager } from "../../shared/database.js";
import type { SessionRunnerRegistry, SystemTurnDeps } from "../session-runner.js";
import type { SessionContainerManager } from "../session-container.js";
import { reattachInFlightTurns } from "../restart-turn-reattach.js";
import { sessionSpawnIdentity } from "../service-routing.js";
import { forgetStatusCardSpawn, statusCardSpawnValue } from "../session-status-spawn-record.js";
import { forgetServiceMcpSpawn, serviceMcpSetKey, serviceMcpSpawnKey } from "../service-mcp.js";
import { residentBackgroundWork } from "../turn-admission.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import { PLACEHOLDER_WORKER_URL } from "../worker-http.js";
import type {
  AgentProcess,
  AgentProcessEvents,
  AgentId,
  AgentRunParams,
  PermissionMode,
  WorkerAgentStatus,
} from "../../shared/types.js";

class FakeWorkerAgent extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  constructor(readonly agentId: AgentId) {
    super();
  }
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
    supportsReview: true,
    supportsSteering: true,
    supportsCompaction: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };
  runCalled = false;
  killed = false;
  readonly isStreaming = true;
  sentMessages: string[] = [];
  permissionModes: (PermissionMode | undefined)[] = [];

  run(_params: AgentRunParams): void { this.runCalled = true; }
  writeStdin(_data: string): void {}
  sendUserMessage(text: string): void { this.sentMessages.push(text); }
  interrupt(): void {}
  kill(): void {
    this.killed = true;
    this.emit("done", 0);
  }
  setPermissionMode(mode: PermissionMode | undefined): void { this.permissionModes.push(mode); }
  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } {
    return {};
  }
}

async function waitFor(fn: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

const SESSION_ID = "idle-resident-session";
const SESSION_DIR = "/tmp/idle-resident-session";
const OLD_MODEL_IDENTITY = "claude|anthropic|sub|claude-old-model|-|-";

describe("Integration: the next turn after a restart takes over the idle resident process (planning#700)", () => {
  let worker: SessionWorker;
  let workerUrl: string;
  let allAgents: FakeWorkerAgent[];
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let runners: ContainerSessionRunner[];
  let commits: string[];
  let workBeforeCompactionDecision: string[] | null;

  const resident = () => allAgents[0]!;
  const identity = () => sessionSpawnIdentity(sessionManager.get(SESSION_ID)!, "claude");

  beforeEach(async () => {
    allAgents = [];
    runners = [];
    commits = [];
    forgetStatusCardSpawn(SESSION_ID);
    forgetServiceMcpSpawn(SESSION_ID);
    workBeforeCompactionDecision = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    worker = new SessionWorker({
      agentFactory: (agentId) => {
        const agent = new FakeWorkerAgent(agentId);
        allAgents.push(agent);
        return agent;
      },
      port: 0,
      host: "127.0.0.1",
    });
    const address = await worker.start();
    workerUrl = `http://127.0.0.1:${Number(/:(\d+)$/.exec(address)?.[1] ?? 0)}`;

    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    sessionManager.track(SESSION_ID, "Idle resident session", SESSION_DIR);
  });

  afterEach(async () => {
    for (const r of runners) r.dispose({ force: true });
    await worker.stop();
    dbManager.close();
    vi.restoreAllMocks();
    await new Promise((r) => setTimeout(r, 50));
  });

  function makeRunner(): ContainerSessionRunner {
    const runner = new ContainerSessionRunner({
      sessionId: SESSION_ID,
      sessionDir: SESSION_DIR,
      defaultAgentId: "claude",
      workerUrl,
    });
    const deps: SystemTurnDeps = {
      agentFactory: (agentId) => runner.createAgent(agentId),
      autoCommit: async () => ({
        commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null, hookFailure: null,
      }),
      scheduleAutoPush: () => {},
      commitTurn: async ({ summary }) => {
        commits.push(summary);
        return `commit-${commits.length}`;
      },
      buildRunParams: async (_sessionId, _agentId, prompt) => ({ prompt, cwd: "/workspace" }),
      steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
      shouldCompactBeforeTurn: async (r) => {
        workBeforeCompactionDecision = residentBackgroundWork(r);
        return false;
      },
      statusCardEnabled: () => false,
      answerHold: sessionManager,
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

  function registry(): SessionRunnerRegistry {
    return {
      get: () => runners.at(-1),
      getOrCreate: () => runners.at(-1) ?? makeRunner(),
    } as unknown as SessionRunnerRegistry;
  }

  function restartSweep(): Promise<number> {
    const container = { sessionId: SESSION_ID, workerUrl, status: "running", workerBuildId: "current-build" };
    return reattachInFlightTurns({
      containerManager: {
        get: () => container,
        getAll: () => [container],
        isStandby: () => false,
        destroyAgentContainer: async () => {},
      } as unknown as SessionContainerManager,
      runnerRegistry: registry(),
      sessionManager,
      defaultAgentId: "claude",
      chatHistoryManager,
      orchestratorBuildId: "current-build",
      confirmDelayMs: 0,
    });
  }

  const workerStatus = async () => (await fetch(`${workerUrl}/agent/status`)).json() as Promise<WorkerAgentStatus>;

  // The orchestrator that ran this turn is gone; the streaming CLI stays in the worker.
  async function turnOfThePreviousOrchestrator(opts: {
    spawnIdentity?: string | null;
    permissionMode?: PermissionMode;
    sessionStatusCard?: boolean;
    ends?: boolean;
  } = {}): Promise<void> {
    const spawnIdentity = opts.spawnIdentity === undefined ? identity() : opts.spawnIdentity;
    const res = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "claude",
        runToken: "pre-restart-token",
        ...(spawnIdentity !== null ? { spawnIdentity } : {}),
        params: {
          prompt: "first task",
          cwd: "/workspace",
          useStreaming: true,
          ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
          ...(opts.sessionStatusCard ? { sessionStatusCard: true } : {}),
        },
      }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => allAgents[0]?.runCalled ?? false, 2000, "worker started the agent");
    resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "FIRST_TEXT" }] });
    if (opts.ends !== false) endTurn();
  }

  function endTurn(text?: string): void {
    if (text) resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text }] });
    resident().emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });
  }

  async function turnEnds(runner: ContainerSessionRunner, commitCount: number): Promise<void> {
    await waitFor(() => !runner.running && commits.length === commitCount, 3000, "the turn ended and committed");
  }

  it("runs the next turn on the process that survived the restart (req 1)", async () => {
    await turnOfThePreviousOrchestrator();
    expect(await restartSweep()).toBe(0);
    expect(runners, "the sweep wakes no idle session").toEqual([]);

    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "next task" }));
    await waitFor(() => resident().sentMessages.length === 1, 3000, "the turn reached the surviving process");
    expect(resident().sentMessages[0]).toContain("next task");
    expect(allAgents).toHaveLength(1);
    expect(resident().killed).toBe(false);
    expect(runner.isStreamingActive).toBe(true);
    expect(runner.appliedSpawnIdentity).toBe(identity());

    endTurn("NEXT_TEXT");
    await turnEnds(runner, 1);
    expect(chatHistoryManager.load(SESSION_ID).map((m) => m.text ?? "").join("\n")).toContain("NEXT_TEXT");

    // From here it is an ordinary held resident.
    runner.dispatch(testDispatch({ text: "third task" }));
    await waitFor(() => resident().sentMessages.length === 2, 3000, "the next turn reused it again");
    expect(allAgents).toHaveLength(1);
  });

  it("still follows a turn the process starts by itself after a taken-over turn (req 4)", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "next task" }));
    await waitFor(() => resident().sentMessages.length === 1, 3000, "the turn reached the surviving process");
    endTurn();
    await turnEnds(runner, 1);

    resident().emit("event", { type: "agent_self_wake", taskId: "task-1", status: "completed" });
    resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "WAKE_TEXT" }] });
    await waitFor(() => runner.running, 3000, "the session shows as running");
    endTurn();
    await turnEnds(runner, 2);
    expect(chatHistoryManager.load(SESSION_ID).map((m) => m.text ?? "").join("\n")).toContain("WAKE_TEXT");
  });

  it("replaces the process when the session's spawn facts changed during the restart (req 3)", async () => {
    await turnOfThePreviousOrchestrator({ spawnIdentity: OLD_MODEL_IDENTITY });
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "next task" }));

    await waitFor(() => allAgents.length === 2 && allAgents[1]!.runCalled, 3000, "a new process started");
    expect(resident().killed).toBe(true);
    expect(resident().sentMessages).toEqual([]);
    expect(runner.appliedSpawnIdentity).toBe(identity());
  });

  it("restores the status-card value the process was started with (req 3)", async () => {
    await turnOfThePreviousOrchestrator({ sessionStatusCard: true });
    const runner = makeRunner();
    expect(await runner.attachIdleResident()).toBe(true);
    expect(statusCardSpawnValue(SESSION_ID)).toBe(true);
  });

  it("applies the turn's permission mode to a process started in another (req 3)", async () => {
    await turnOfThePreviousOrchestrator({ permissionMode: "plan" });
    expect((await workerStatus()).resident?.permissionMode).toBe("plan");
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "next task" }));

    await waitFor(() => resident().sentMessages.length === 1, 3000, "the turn reached the surviving process");
    expect(resident().permissionModes).toEqual([undefined]);
    expect((await workerStatus()).resident?.permissionMode).toBeUndefined();
  });

  it("sends no mode change when the turn's mode is the one the process holds", async () => {
    await turnOfThePreviousOrchestrator({ permissionMode: "plan" });
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "next task", permissionMode: "plan" }));

    await waitFor(() => resident().sentMessages.length === 1, 3000, "the turn reached the surviving process");
    expect(resident().permissionModes).toEqual([]);
  });

  it("keeps a process with background tasks, and counts them as its work (req 4)", async () => {
    await turnOfThePreviousOrchestrator();
    resident().emit("event", { type: "agent_background_tasks", tasks: [{ id: "bg-1", description: "npm test" }] });
    expect((await workerStatus()).backgroundTasks).toEqual([{ id: "bg-1", description: "npm test" }]);
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "next task" }));

    await waitFor(() => resident().sentMessages.length === 1, 3000, "the turn reached the surviving process");
    expect(resident().killed).toBe(false);
    expect(runner.backgroundTaskDescriptions).toEqual(["npm test"]);
  });

  it("replaces, as before, a process whose worker kept no spawn facts (an older build)", async () => {
    await turnOfThePreviousOrchestrator({ spawnIdentity: null });
    expect((await workerStatus()).resident).toBeUndefined();
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "next task" }));

    await waitFor(() => allAgents.length === 2 && allAgents[1]!.runCalled, 3000, "a new process started");
    expect(resident().sentMessages).toEqual([]);
  });

  it("does not take over a process that exited after the first connect read it", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    expect(await runner.resumeInFlightTurn()).toBe(false);
    expect(runner.residentToAttach).toBe(true);
    resident().emit("done", 0);
    expect((await workerStatus()).running).toBe(false);

    runner.dispatch(testDispatch({ text: "next task" }));
    await waitFor(() => allAgents.length === 2 && allAgents[1]!.runCalled, 3000, "a new process started");
    expect(resident().sentMessages).toEqual([]);
  });

  it("takes the process over when the message arrives while a viewer's first reading is under way", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    runner.attachViewer();
    runner.dispatch(testDispatch({ text: "next task" }));

    await waitFor(() => resident().sentMessages.length === 1, 3000, "the turn reached the surviving process");
    expect(allAgents).toHaveLength(1);
  });

  it("restores the process's background tasks before the compaction-before-turn decision", async () => {
    await turnOfThePreviousOrchestrator();
    resident().emit("event", { type: "agent_background_tasks", tasks: [{ id: "bg-1", description: "npm test" }] });
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "next task" }));

    await waitFor(() => resident().sentMessages.length === 1, 3000, "the turn reached the surviving process");
    // Resident work skips the decision: a turn of the CLI's own could come between compaction and message.
    expect(workBeforeCompactionDecision).toBeNull();
  });

  it("control: with no background task, the compaction-before-turn decision is made", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "next task" }));

    await waitFor(() => resident().sentMessages.length === 1, 3000, "the turn reached the surviving process");
    expect(workBeforeCompactionDecision).toEqual([]);
  });

  it("still follows a turn the CLI starts on a process taken over but not yet used (req 4)", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    expect(await runner.attachIdleResident()).toBe(true);

    resident().emit("event", { type: "agent_background_tasks", tasks: [{ id: "bg-2", description: "npm run build" }] });
    await waitFor(() => runner.backgroundTaskDescriptions.length === 1, 3000, "the task list stays current");
    resident().emit("event", { type: "agent_self_wake", taskId: "bg-2", status: "completed" });
    resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "WAKE_TEXT" }] });
    await waitFor(() => runner.running, 3000, "the session shows as running");
    endTurn();
    await turnEnds(runner, 1);
    expect(chatHistoryManager.load(SESSION_ID).map((m) => m.text ?? "").join("\n")).toContain("WAKE_TEXT");
  });

  it("keeps the taken-over facts when a turn the CLI starts is adopted, not the first connect's", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    expect(await runner.resumeInFlightTurn()).toBe(false);
    const changed = await fetch(`${workerUrl}/agent/permission-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "plan" }),
    });
    expect(changed.status).toBe(200);
    expect(await runner.attachIdleResident()).toBe(true);
    expect(runner.appliedPermissionMode).toBe("plan");

    resident().emit("event", { type: "agent_self_wake", taskId: "task-1", status: "completed" });
    resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "WAKE_TEXT" }] });
    await waitFor(() => runner.running, 3000, "the session shows as running");
    expect(runner.appliedPermissionMode).toBe("plan");
  });

  it("lets go of a process taken over but not yet used when it exits", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    expect(await runner.attachIdleResident()).toBe(true);

    resident().emit("done", 0);
    await waitFor(() => runner.getAgent() === null, 3000, "the runner let go of the process");
    expect(runner.isStreamingActive).toBe(false);
    expect(runner.residentToAttach).toBe(false);
  });

  it("forgets an unfollowed process that exits before any turn reads it", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    expect(await runner.resumeInFlightTurn()).toBe(false);
    expect(runner.residentToAttach).toBe(true);

    resident().emit("done", 0);
    await waitFor(() => !runner.residentToAttach, 3000, "the exit reached the runner");
  });

  it("follows a mode change the CLI makes by itself, so the restore is the process's real mode (req 3)", async () => {
    await turnOfThePreviousOrchestrator({ ends: false });
    resident().emit("event", {
      type: "agent_assistant",
      content: [{ type: "tool_use", id: "t1", name: "EnterPlanMode", input: {} }],
    });
    endTurn();
    expect((await workerStatus()).resident?.permissionMode).toBe("plan");

    resident().emit("event", { type: "agent_init", agentId: "claude", sessionId: "cli-session-1", model: "m", tools: [], permissionMode: "default" });
    expect((await workerStatus()).resident?.permissionMode).toBeUndefined();
  });

  it("restores the MCP servers the process holds, for the next turn's comparison (req 3)", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    expect(serviceMcpSpawnKey(SESSION_ID)).toBeUndefined();
    expect(await runner.attachIdleResident()).toBe(true);
    expect(serviceMcpSpawnKey(SESSION_ID)).toBe(serviceMcpSetKey((await workerStatus()).resident?.serviceMcpServers ?? []));
  });

  it("gives a rebase step a process of its own, as without a restart (req 1)", async () => {
    await turnOfThePreviousOrchestrator();
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "resolve the conflicts", postTurn: "none" }));

    await waitFor(() => allAgents.length === 2 && allAgents[1]!.runCalled, 3000, "a new process started");
    expect(resident().sentMessages).toEqual([]);
  });

  it("does not wait for a container that is still being created", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: SESSION_ID,
      sessionDir: SESSION_DIR,
      defaultAgentId: "claude",
      workerUrl: PLACEHOLDER_WORKER_URL,
    });
    runners.push(runner);
    expect(runner.residentToAttach).toBe(false);
    expect(await runner.attachIdleResident()).toBe(false);
  });

  it("restores the spawn facts of an adopted turn, so a later change replaces its process (req 3)", async () => {
    await turnOfThePreviousOrchestrator({ spawnIdentity: OLD_MODEL_IDENTITY, ends: false });
    expect(await restartSweep()).toBe(1);
    const runner = runners[0]!;
    expect(runner.appliedSpawnIdentity).toBe(OLD_MODEL_IDENTITY);
    endTurn();
    await turnEnds(runner, 1);

    runner.dispatch(testDispatch({ text: "next task" }));
    await waitFor(() => allAgents.length === 2 && allAgents[1]!.runCalled, 3000, "a new process started");
    expect(resident().killed).toBe(true);
  });
});
