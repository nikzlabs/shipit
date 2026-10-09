import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import { SessionWorker } from "../../session/session-worker.js";
import type { OrchestratorClient } from "../../session/orchestrator-client.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { DatabaseManager } from "../../shared/database.js";
import type { SessionRunnerRegistry, SystemTurnDeps } from "../session-runner.js";
import type { SessionContainerManager } from "../session-container.js";
import { followReportedTurn, reattachInFlightTurns } from "../restart-turn-reattach.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import { isTerminalPrResolved } from "../../shared/session-resolution.js";
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
  isStreaming = true;
  sentMessages: string[] = [];

  run(_params: AgentRunParams): void { this.runCalled = true; }
  writeStdin(_data: string): void {}
  sendUserMessage(text: string): void { this.sentMessages.push(text); }
  interrupts = 0;
  interrupt(): void { this.interrupts += 1; }
  kill(): void { this.killed = true; }
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

const SESSION_ID = "self-wake-session";
const SESSION_DIR = "/tmp/self-wake-session";

describe("Integration: a turn the CLI starts on its own after an orchestrator restart (planning#639)", () => {
  let worker: SessionWorker;
  let workerUrl: string;
  let allAgents: FakeWorkerAgent[];
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  // Writes what the orchestrator before the restart saved.
  let earlierProcess: ChatHistoryManager;
  let usageManager: UsageManager;
  let runners: ContainerSessionRunner[];
  let commits: string[];
  let sseEvents: string[];
  let warnings: string[];
  let destroyed: string[];
  let oneShot: boolean;
  let workerReports: string[];
  let orchestratorIsUp: boolean;
  let stream: http.ClientRequest | null;

  const resident = () => allAgents[0]!;

  beforeEach(async () => {
    oneShot = false;
    allAgents = [];
    runners = [];
    commits = [];
    sseEvents = [];
    warnings = [];
    destroyed = [];
    workerReports = [];
    orchestratorIsUp = false;
    stream = null;
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
    worker = new SessionWorker({
      agentFactory: (agentId) => {
        const agent = new FakeWorkerAgent(agentId);
        agent.isStreaming = !oneShot;
        allAgents.push(agent);
        return agent;
      },
      // The route's own handler stands in for the HTTP hop to the orchestrator.
      createOrchestratorClient: () => ({
        request: async (_method: string, suffix: string) => {
          workerReports.push(suffix);
          if (!orchestratorIsUp) return { ok: false, status: 0, body: null };
          return { ok: true, status: 200, body: { following: await reportReachesTheOrchestrator() } };
        },
      }) as unknown as OrchestratorClient,
      port: 0,
      host: "127.0.0.1",
    });
    const address = await worker.start();
    workerUrl = `http://127.0.0.1:${Number(/:(\d+)$/.exec(address)?.[1] ?? 0)}`;

    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    earlierProcess = new ChatHistoryManager(dbManager);
    usageManager = new UsageManager(dbManager);
    sessionManager.track(SESSION_ID, "Self-wake session", SESSION_DIR);
  });

  afterEach(async () => {
    stream?.destroy();
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
      statusCardEnabled: () => false,
      answerHold: sessionManager,
      listenerDeps: {
        sessionManager,
        chatHistoryManager,
        usageManager,
        sseBroadcast: (event) => { sseEvents.push(event); },
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

  function containers(workerBuildId = "current-build"): SessionContainerManager {
    const container = { sessionId: SESSION_ID, workerUrl, status: "running", workerBuildId };
    return {
      get: () => container,
      getAll: () => [container],
      isStandby: () => false,
      destroyAgentContainer: async (sessionId: string) => { destroyed.push(sessionId); },
    } as unknown as SessionContainerManager;
  }

  // What the route `POST /api/sessions/:id/agent/own-turn` does with the worker's report.
  const reportReachesTheOrchestrator = () =>
    followReportedTurn(
      { containerManager: containers(), runnerRegistry: registry(), sessionManager, defaultAgentId: "claude" },
      SESSION_ID,
    );

  const workerStatus = async () => (await fetch(`${workerUrl}/agent/status`)).json() as Promise<WorkerAgentStatus>;
  const history = () => chatHistoryManager.load(SESSION_ID);
  const historyText = () => history().map((m) => m.text ?? "").join("\n");
  const dropped = () => warnings.filter((w) => w.includes("dropped (no _agent)"));

  // The orchestrator that ran this turn is gone; the streaming CLI stays resident and idle.
  async function turnOfThePreviousOrchestrator(opts: { ends?: boolean; agentId?: AgentId } = {}): Promise<void> {
    const res = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: opts.agentId ?? "claude",
        runToken: "pre-restart-token",
        params: { prompt: "run the tests in the background", cwd: "/workspace", useStreaming: !oneShot },
      }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => allAgents[0]?.runCalled ?? false, 2000, "worker started the agent");
    resident().emit("event", { type: "agent_init", agentId: "claude", sessionId: "cli-session-1", model: "claude-sonnet-4-6", tools: [] });
    resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "FIRST_TEXT" }] });
    earlierProcess.append(SESSION_ID, { role: "user", text: "run the tests in the background" });
    if (opts.ends === false) return;
    endTurn();
    earlierProcess.append(SESSION_ID, { role: "assistant", text: "FIRST_TEXT" });
  }

  // The previous orchestrator's stream to the worker, which hears a turn start.
  async function previousOrchestratorListens(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream = http.get(`${workerUrl}/events?since=0`, () => resolve());
      stream.on("error", reject);
    });
  }

  function selfWake(text = "WAKE_TEXT"): void {
    resident().emit("event", { type: "agent_self_wake", taskId: "task-1", status: "completed", summary: "npm test finished" });
    resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text }] });
  }

  // docs/140-live-steering Phase 6.11: a late steer runs as a turn of its own, with no notification.
  function answerLateSteer(): void {
    resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "LATE_STEER_ANSWER" }] });
  }

  function endTurn(): void {
    resident().emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });
  }

  function restartSweep(workerBuildId = "current-build"): Promise<number> {
    return reattachInFlightTurns({
      containerManager: containers(workerBuildId),
      runnerRegistry: registry(),
      sessionManager,
      defaultAgentId: "claude",
      chatHistoryManager,
      orchestratorBuildId: "current-build",
      confirmDelayMs: 0,
    });
  }

  // What a viewer that opens the session does: the first connect to the worker.
  async function connectedIdleRunner(): Promise<ContainerSessionRunner> {
    const runner = makeRunner();
    expect(await runner.resumeInFlightTurn()).toBe(false);
    return runner;
  }

  async function expectTurnSaved(text: string, commitCount = 1): Promise<void> {
    await waitFor(() => commits.length === commitCount, 3000, "post-turn commit");
    expect(historyText()).toContain(text);
    expect(history().some((m) => m.inProgress)).toBe(false);
  }

  it("control: with no restart, the orchestrator follows a self-woken turn", async () => {
    const runner = makeRunner();
    runner.dispatch(testDispatch({ text: "run the tests in the background" }));
    await waitFor(() => allAgents[0]?.runCalled ?? false, 3000, "first turn started");
    resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "FIRST_TEXT" }] });
    endTurn();
    await waitFor(() => !runner.running && commits.length === 1, 3000, "first turn committed");

    selfWake();
    await waitFor(() => runner.running, 3000, "the session shows as running");
    endTurn();
    await expectTurnSaved("WAKE_TEXT", 2);
    expect((await workerStatus()).ownTurn).toBeUndefined();
  });

  describe("a turn in flight when the orchestrator starts", () => {
    it("is adopted from its first event, and saved one time", async () => {
      await turnOfThePreviousOrchestrator();
      selfWake();
      expect(await workerStatus()).toMatchObject({ turnActive: true, ownTurn: "unheard" });

      expect(await restartSweep()).toBe(1);
      const runner = runners[0]!;
      expect(runner.running).toBe(true);
      expect(sseEvents).toContain("session_agent_started");
      // A second restart inside this turn must replace what this orchestrator saves, not keep it.
      expect((await workerStatus()).ownTurn).toBe("heard");
      resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "WAKE_TAIL" }] });
      endTurn();

      await expectTurnSaved("WAKE_TAIL");
      expect(historyText().split("WAKE_TEXT")).toHaveLength(2);
    });

    it("replaces the part of it the previous orchestrator saved", async () => {
      await turnOfThePreviousOrchestrator();
      await previousOrchestratorListens();
      selfWake();
      expect((await workerStatus()).ownTurn).toBe("heard");
      earlierProcess.append(SESSION_ID, { role: "assistant", text: "WAKE_TEXT", inProgress: true });

      expect(await restartSweep()).toBe(1);
      endTurn();

      await expectTurnSaved("WAKE_TEXT");
      expect(historyText().split("WAKE_TEXT")).toHaveLength(2);
    });

    it("keeps the saved part of the turn before it, which ended with no orchestrator listening", async () => {
      await turnOfThePreviousOrchestrator({ ends: false });
      earlierProcess.append(SESSION_ID, { role: "assistant", text: "FIRST_TEXT", inProgress: true });
      endTurn();
      selfWake();

      expect(await restartSweep()).toBe(1);
      endTurn();

      await expectTurnSaved("WAKE_TEXT");
      expect(historyText()).toContain("FIRST_TEXT");
    });

    it("is adopted on an update when it started with assistant output, and its container is kept", async () => {
      await turnOfThePreviousOrchestrator();
      answerLateSteer();
      expect(await workerStatus()).toMatchObject({ turnActive: true, ownTurn: "unheard" });

      expect(await restartSweep("build-before-the-update")).toBe(1);
      expect(destroyed).toEqual([]);
      endTurn();
      await expectTurnSaved("LATE_STEER_ANSWER");
    });

    // docs/316-done-sessions-return-memory req 5: a turn that starts after the merge reopens the session.
    it("is new use of a session whose PR merged", async () => {
      await turnOfThePreviousOrchestrator();
      sessionManager.markMerged(SESSION_ID);
      await new Promise((r) => setTimeout(r, 5));
      selfWake();

      expect(await restartSweep()).toBe(1);
      expect(isTerminalPrResolved(sessionManager.get(SESSION_ID)!)).toBe(false);
    });

    it("is not new use again when an orchestrator already counted its start", async () => {
      await turnOfThePreviousOrchestrator();
      await previousOrchestratorListens();
      selfWake();
      sessionManager.markMerged(SESSION_ID);
      await new Promise((r) => setTimeout(r, 5));

      expect(await restartSweep()).toBe(1);
      expect(isTerminalPrResolved(sessionManager.get(SESSION_ID)!)).toBe(true);
    });

    it("is not new use when it was sent, though a task notified inside it", async () => {
      await turnOfThePreviousOrchestrator({ ends: false });
      resident().emit("event", { type: "agent_self_wake", taskId: "task-0", status: "completed" });
      expect(await workerStatus()).toMatchObject({ turnActive: true, selfWakeActive: true });
      sessionManager.markMerged(SESSION_ID);
      await new Promise((r) => setTimeout(r, 5));

      expect(await restartSweep()).toBe(1);
      expect(isTerminalPrResolved(sessionManager.get(SESSION_ID)!)).toBe(true);
    });
  });

  describe("a turn that starts on a connected runner with no agent", () => {
    it("is followed from the task notification that starts it", async () => {
      await turnOfThePreviousOrchestrator();
      expect(await restartSweep()).toBe(0);
      const runner = await connectedIdleRunner();

      selfWake();
      await waitFor(() => runner.running, 3000, "the session shows as running");
      expect(runner.agentBusy).toBe(true);
      expect(sseEvents).toContain("session_agent_started");
      expect(workerReports, "the open stream is how the orchestrator hears it").toEqual([]);
      endTurn();

      await expectTurnSaved("WAKE_TEXT");
      expect(dropped()).toEqual([]);
    });

    it("is followed from the answer to a late steer", async () => {
      await turnOfThePreviousOrchestrator();
      const runner = await connectedIdleRunner();

      answerLateSteer();
      await waitFor(() => runner.running, 3000, "the session shows as running");
      endTurn();

      await expectTurnSaved("LATE_STEER_ANSWER");
    });

    it("is saved and committed when all of it arrives in one burst", async () => {
      await turnOfThePreviousOrchestrator();
      const runner = await connectedIdleRunner();

      selfWake();
      endTurn();

      await expectTurnSaved("WAKE_TEXT");
      expect(dropped()).toEqual([]);
      expect(runner.running).toBe(false);
    });

    it("is not killed by a message that arrives while it runs", async () => {
      await turnOfThePreviousOrchestrator();
      const runner = await connectedIdleRunner();
      selfWake();
      await waitFor(() => runner.running, 3000, "the turn is followed");

      runner.dispatch(testDispatch({ text: "how is it going?" }));
      await waitFor(() => resident().sentMessages.length === 1, 3000, "the message reaches the running turn");
      expect(resident().killed).toBe(false);
      expect(allAgents).toHaveLength(1);
    });

    it("is new use of a session whose PR merged", async () => {
      await turnOfThePreviousOrchestrator();
      sessionManager.markMerged(SESSION_ID);
      await new Promise((r) => setTimeout(r, 5));
      const runner = await connectedIdleRunner();
      expect(isTerminalPrResolved(sessionManager.get(SESSION_ID)!)).toBe(true);

      selfWake();
      await waitFor(() => runner.running, 3000, "the turn is followed");
      expect(isTerminalPrResolved(sessionManager.get(SESSION_ID)!)).toBe(false);
    });

    it("leaves a queue hold that a rebase or a recovery took", async () => {
      await turnOfThePreviousOrchestrator();
      const runner = await connectedIdleRunner();
      runner.systemTurnInProgress = true;

      selfWake();
      await waitFor(() => runner.running, 3000, "the turn is followed");
      expect(runner.systemTurnInProgress).toBe(true);
    });

    // docs/322-question-holds-automatic-turns req 7, as without a restart.
    it("is stopped at once while the agent waits for the user's answer", async () => {
      await turnOfThePreviousOrchestrator();
      const runner = await connectedIdleRunner();
      sessionManager.setAwaitingAnswer(SESSION_ID, true);

      selfWake();
      await waitFor(() => resident().interrupts === 1, 3000, "the turn is interrupted");
      expect(runner.awaitingUserAnswer).toBe(true);
    });
  });

  describe("a turn that starts in a session with no runner", () => {
    it("is reported by the worker, and the orchestrator follows it from its first event", async () => {
      await turnOfThePreviousOrchestrator();
      expect(await restartSweep()).toBe(0);
      expect(runners, "the sweep wakes no idle session").toEqual([]);
      orchestratorIsUp = true;

      selfWake();
      await waitFor(() => runners[0]?.running ?? false, 3000, "the session shows as running");
      expect(workerReports).toEqual(["/agent/own-turn"]);
      endTurn();

      await expectTurnSaved("WAKE_TEXT");
    });

    it("gets no runner from a report when the worker has no turn in flight", async () => {
      await turnOfThePreviousOrchestrator();

      expect(await reportReachesTheOrchestrator()).toBe(false);
      expect(runners).toEqual([]);
    });

    it("is adopted by the next boot sweep when the report found no orchestrator", async () => {
      await turnOfThePreviousOrchestrator();

      selfWake();
      await waitFor(() => workerReports.length === 1, 3000, "the worker reported the turn");
      expect(runners).toEqual([]);

      expect(await restartSweep()).toBe(1);
      endTurn();
      await expectTurnSaved("WAKE_TEXT");
    });
  });

  describe("what must not be adopted", () => {
    async function expectLateOutputDropped(runner: ContainerSessionRunner): Promise<void> {
      selfWake();
      await waitFor(
        () => warnings.some((w) => w.includes("type=agent_assistant dropped (no _agent)")),
        3000,
        "the output is dropped",
      );
      expect(runner.running).toBe(false);
      expect(commits).toEqual([]);
    }

    it("a one-shot process that notifies between its result and its exit", async () => {
      oneShot = true;
      await turnOfThePreviousOrchestrator();
      const runner = await connectedIdleRunner();

      await expectLateOutputDropped(runner);
      expect(await workerStatus()).toMatchObject({ turnActive: false, selfWakeActive: true });
    });

    it("the late output of a process that was killed before the restart", async () => {
      await turnOfThePreviousOrchestrator();
      const killed = await fetch(`${workerUrl}/agent/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(killed.status).toBe(200);
      const runner = await connectedIdleRunner();

      await expectLateOutputDropped(runner);
    });

    it("the late output of a process the user had killed through this runner", async () => {
      await turnOfThePreviousOrchestrator();
      const runner = await connectedIdleRunner();
      await runner.killAgentOnWorker();

      await expectLateOutputDropped(runner);
    });

    it("the late output of a process that a new message replaced", async () => {
      await turnOfThePreviousOrchestrator();
      const runner = await connectedIdleRunner();
      runner.dispatch(testDispatch({ text: "next task" }));
      await waitFor(() => allAgents.length === 2 && allAgents[1]!.runCalled, 3000, "the replacement started");
      const ownAgent = runner.getAgent();

      selfWake();
      await waitFor(() => warnings.some((w) => w.includes("stale spawn ignored")), 3000, "the output is ignored");
      expect(runner.getAgent()).toBe(ownAgent);
      expect(historyText()).not.toContain("WAKE_TEXT");
    });

    it("the late output of a killed process, when the worker holds its replacement", async () => {
      await turnOfThePreviousOrchestrator();
      await fetch(`${workerUrl}/agent/kill`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const replacement = await fetch(`${workerUrl}/agent/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "claude",
          runToken: "replacement-token",
          params: { prompt: "continue", cwd: "/workspace", useStreaming: true },
        }),
      });
      expect(replacement.status).toBe(200);
      await waitFor(() => allAgents[1]?.runCalled ?? false, 2000, "the replacement started");
      allAgents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });
      const runner = await connectedIdleRunner();

      await expectLateOutputDropped(runner);
    });

    it("output after the result of a backend that starts no turns of its own", async () => {
      await turnOfThePreviousOrchestrator({ agentId: "codex" });
      const runner = await connectedIdleRunner();

      resident().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "FINAL_TEXT" }] });
      await waitFor(
        () => warnings.some((w) => w.includes("type=agent_assistant dropped (no _agent)")),
        3000,
        "the output is dropped",
      );
      expect(runner.running).toBe(false);
    });
  });

  it("control: an update reclaims the container of an idle session", async () => {
    await turnOfThePreviousOrchestrator();

    await restartSweep("build-before-the-update");
    expect(destroyed).toEqual([SESSION_ID]);
  });
});
