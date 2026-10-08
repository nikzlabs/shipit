import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SessionWorker } from "../../session/session-worker.js";
import type { OrchestratorClient } from "../../session/orchestrator-client.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionRunnerRegistry, type SystemTurnDeps } from "../session-runner.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import type { SessionContainerManager } from "../session-container.js";
import {
  followReportedTurn,
  reattachInFlightTurns,
  runnerForContainerCall,
  unprobedAfterRestart,
} from "../restart-turn-reattach.js";
import type {
  AgentProcess,
  AgentProcessEvents,
  AgentId,
  AgentRunParams,
  PermissionMode,
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

  run(_params: AgentRunParams): void { this.runCalled = true; }
  writeStdin(_data: string): void {}
  sendUserMessage(_text: string): void {}
  interrupt(): void {}
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

const SESSION_ID = "message-turn-session";
const SESSION_DIR = "/tmp/message-turn-session";
const FIRST_CONNECT_RETRY_DELAYS_MS = ContainerSessionRunner.firstConnectRetryDelaysMs;

describe("Integration: a sent turn that continues across an orchestrator restart (planning#665)", () => {
  let worker: SessionWorker;
  let workerUrl: string;
  // The orchestrator reaches the worker through this, so a test can make a status read fail.
  let proxy: http.Server;
  let proxyUrl: string;
  // Read in order first; when it is empty, `statusUnreadable` decides.
  let statusReads: ("ok" | "fail")[];
  let statusUnreadable: boolean;
  let statusDelayMs: number;
  let killDelayMs: number;
  let refuseStarts: boolean;
  let agents: FakeWorkerAgent[];
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let earlierProcess: ChatHistoryManager;
  let usageManager: UsageManager;
  let registry: SessionRunnerRegistry;
  let commits: string[];
  let destroyed: string[];
  let stream: http.ClientRequest | null;

  const agent = () => agents[0]!;

  beforeEach(async () => {
    agents = [];
    commits = [];
    destroyed = [];
    statusReads = [];
    statusUnreadable = false;
    statusDelayMs = 0;
    killDelayMs = 0;
    refuseStarts = false;
    stream = null;
    unprobedAfterRestart.clear();
    ContainerSessionRunner.firstConnectRetryDelaysMs = [20, 20, 40];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    worker = new SessionWorker({
      agentFactory: (agentId) => {
        const a = new FakeWorkerAgent(agentId);
        agents.push(a);
        return a;
      },
      createOrchestratorClient: () => ({
        request: async () => ({ ok: true, status: 200, body: { following: await ownTurnRoute() } }),
      }) as unknown as OrchestratorClient,
      port: 0,
      host: "127.0.0.1",
    });
    const address = await worker.start();
    workerUrl = `http://127.0.0.1:${Number(/:(\d+)$/.exec(address)?.[1] ?? 0)}`;
    const target = new URL(workerUrl);
    proxy = http.createServer((req, res) => {
      if (req.url?.startsWith("/agent/start") && refuseStarts) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "start refused" }));
        return;
      }
      if (req.url?.startsWith("/agent/kill")) {
        setTimeout(() => forward(req, res), killDelayMs);
        return;
      }
      if (!req.url?.startsWith("/agent/status")) {
        forward(req, res);
        return;
      }
      const fails = statusReads.length > 0 ? statusReads.shift() === "fail" : statusUnreadable;
      if (fails) {
        res.writeHead(503).end();
        return;
      }
      // The worker answers now; the answer arrives late.
      forward(req, res, statusDelayMs);
    });
    const forward = (req: http.IncomingMessage, res: http.ServerResponse, delayMs = 0): void => {
      const upstream = http.request(
        { host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers },
        (up) => {
          setTimeout(() => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          }, delayMs);
        },
      );
      upstream.on("error", () => res.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    };
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    earlierProcess = new ChatHistoryManager(dbManager);
    usageManager = new UsageManager(dbManager);
    sessionManager.track(SESSION_ID, "Sent-turn session", SESSION_DIR);

    registry = new SessionRunnerRegistry({
      runnerFactory: (o) => new ContainerSessionRunner({
        sessionId: o.sessionId,
        sessionDir: o.sessionDir,
        defaultAgentId: o.defaultAgentId,
        workerUrl: proxyUrl,
      }),
      onRunnerCreated: (runner) => {
        (runner as ContainerSessionRunner).setSystemTurnDeps(turnDeps(runner as ContainerSessionRunner));
      },
    });
  });

  afterEach(async () => {
    stream?.destroy();
    registry.disposeAll();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await worker.stop();
    dbManager.close();
    vi.restoreAllMocks();
    unprobedAfterRestart.clear();
    ContainerSessionRunner.firstConnectRetryDelaysMs = FIRST_CONNECT_RETRY_DELAYS_MS;
    await new Promise((r) => setTimeout(r, 50));
  });

  function turnDeps(runner: ContainerSessionRunner): SystemTurnDeps {
    return {
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
        sseBroadcast: () => {},
        broadcastLog: () => {},
        getSelectedModel: () => undefined,
      },
    };
  }

  function containers(workerBuildId = "current-build"): SessionContainerManager {
    const container = { sessionId: SESSION_ID, workerUrl: proxyUrl, status: "running", workerBuildId };
    return {
      get: () => container,
      getAll: () => [container],
      isStandby: () => false,
      destroyAgentContainer: async (sessionId: string) => { destroyed.push(sessionId); },
    } as unknown as SessionContainerManager;
  }

  const ownTurnRoute = () =>
    followReportedTurn(
      { containerManager: containers(), runnerRegistry: registry, sessionManager, defaultAgentId: "claude" },
      SESSION_ID,
    );

  const runner = () => registry.get(SESSION_ID) as ContainerSessionRunner | undefined;
  const history = () => chatHistoryManager.load(SESSION_ID);
  const historyText = () => history().map((m) => m.text ?? "").join("\n");
  const occurrences = (text: string) => historyText().split(text).length - 1;

  // What `shipit agent run` and the other container routes do before they act.
  const agentRunFindsItsSession = async () =>
    (await runnerForContainerCall(
      { containerManager: containers(), runnerRegistry: registry, sessionManager, defaultAgentId: "claude" },
      SESSION_ID,
    )) !== undefined;

  // The orchestrator before the restart sent this turn, saved part of it, and listened to it.
  async function sentTurnOfThePreviousOrchestrator(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream = http.get(`${workerUrl}/events?since=0`, () => resolve());
      stream.on("error", reject);
    });
    const res = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "claude",
        runToken: "pre-restart-token",
        params: { prompt: "implement the feature", cwd: "/workspace", useStreaming: true },
      }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => agents[0]?.runCalled ?? false, 2000, "worker started the agent");
    agent().emit("event", { type: "agent_init", agentId: "claude", sessionId: "cli-session-1", model: "claude-sonnet-4-6", tools: [] });
    agent().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "BEFORE_RESTART" }] });
    earlierProcess.append(SESSION_ID, { role: "user", text: "implement the feature" });
    earlierProcess.append(SESSION_ID, { role: "assistant", text: "BEFORE_RESTART", inProgress: true });
  }

  async function previousOrchestratorStops(): Promise<void> {
    stream?.destroy();
    stream = null;
    await new Promise((r) => setTimeout(r, 50));
  }

  function selfWake(): void {
    agent().emit("event", { type: "agent_self_wake", taskId: "task-1", status: "completed", summary: "tests finished" });
    agent().emit("event", { type: "agent_assistant", content: [{ type: "text", text: "WAKE_TEXT" }] });
  }

  function say(text: string): void {
    agent().emit("event", { type: "agent_assistant", content: [{ type: "text", text }] });
  }

  function endTurn(): void {
    agent().emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });
  }

  function restartSweep(workerBuildId = "current-build", followRetryDelaysMs = [50, 100, 200]): Promise<number> {
    return reattachInFlightTurns({
      containerManager: containers(workerBuildId),
      runnerRegistry: registry,
      sessionManager,
      defaultAgentId: "claude",
      chatHistoryManager,
      orchestratorBuildId: "current-build",
      confirmDelayMs: 0,
      followRetryDelaysMs,
    });
  }

  async function expectFollowed(timeoutMs = 3000): Promise<void> {
    await waitFor(() => runner()?.running === true, timeoutMs, "the turn is followed");
    expect(runner()!.agentBusy).toBe(true);
  }

  async function expectSavedOnceAndCommitted(...texts: string[]): Promise<void> {
    endTurn();
    await waitFor(() => commits.length === 1, 3000, "post-turn commit");
    for (const text of texts) expect(occurrences(text), text).toBe(1);
    expect(history().some((m) => m.inProgress)).toBe(false);
  }

  it("control: the boot sweep adopts the turn, and a call from the turn finds its runner", async () => {
    await sentTurnOfThePreviousOrchestrator();
    await previousOrchestratorStops();

    expect(await restartSweep()).toBe(1);
    await expectFollowed();
    expect(await agentRunFindsItsSession()).toBe(true);
    say("AFTER_RESTART");

    await expectSavedOnceAndCommitted("BEFORE_RESTART", "AFTER_RESTART");
  });

  describe("the boot sweep's status probe fails", () => {
    it("the turn is followed with no message from outside", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      statusReads = ["fail"];

      expect(await restartSweep()).toBe(0);
      expect(unprobedAfterRestart.has(SESSION_ID)).toBe(true);

      await expectFollowed();
      expect(await agentRunFindsItsSession()).toBe(true);
      say("AFTER_RESTART");
      await expectSavedOnceAndCommitted("BEFORE_RESTART", "AFTER_RESTART");
    });

    it("a call from the turn gets a runner that follows it, before the sweep tries again", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      say("WHILE_DOWN");
      statusReads = ["fail"];
      expect(await restartSweep("current-build", [])).toBe(0);
      expect(runner()).toBeUndefined();

      expect(await agentRunFindsItsSession()).toBe(true);
      await expectFollowed();
      say("AFTER_RESTART");
      await expectSavedOnceAndCommitted("BEFORE_RESTART", "WHILE_DOWN", "AFTER_RESTART");
    });

    it("on an update, the container is kept and the turn is followed", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      statusReads = ["fail"];

      await restartSweep("build-before-the-update");
      expect(destroyed).toEqual([]);
      await expectFollowed();
    });
  });

  describe("the worker is stale (an update) and its turn is active", () => {
    it("the turn is adopted, its container is kept, and a call from the turn finds its runner", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();

      expect(await restartSweep("build-before-the-update")).toBe(1);
      expect(destroyed).toEqual([]);
      await expectFollowed();
      expect(await agentRunFindsItsSession()).toBe(true);
      await expectSavedOnceAndCommitted("BEFORE_RESTART");
    });
  });

  describe("the orchestrator is down when the turn's next events come", () => {
    it("the events of the downtime are saved once, with the rest of the turn", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      say("WHILE_DOWN");
      agent().emit("event", { type: "agent_tool_result", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] });
      say("STILL_DOWN");

      expect(await restartSweep()).toBe(1);
      await expectFollowed();
      say("AFTER_RESTART");

      await expectSavedOnceAndCommitted("BEFORE_RESTART", "WHILE_DOWN", "STILL_DOWN", "AFTER_RESTART");
    });
  });

  describe("a runner's first connect cannot read the worker's status", () => {
    it("it reads again before the stream opens, and adopts the turn from its first event", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      say("WHILE_DOWN");
      // The sweep's probe answers; the first read of the runner it makes does not.
      statusReads = ["ok", "fail"];

      await restartSweep();
      await expectFollowed();
      // The idle reclaim must not take the runner of a live turn.
      registry.dispose(SESSION_ID);
      expect(await agentRunFindsItsSession()).toBe(true);
      say("AFTER_RESTART");
      await expectSavedOnceAndCommitted("BEFORE_RESTART", "WHILE_DOWN", "AFTER_RESTART");
    });

    it("a second restart inside the adopted turn still saves the turn once", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      statusReads = ["ok", "fail"];
      await restartSweep();
      await expectFollowed();
      say("BETWEEN_RESTARTS");
      agent().emit("event", { type: "agent_tool_result", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] });
      await waitFor(() => history().some((m) => m.inProgress && m.text?.includes("BETWEEN_RESTARTS")), 3000, "partial rows saved");

      registry.disposeAll({ preserveAgent: true });
      chatHistoryManager = new ChatHistoryManager(dbManager);
      expect(await restartSweep()).toBe(1);
      say("AFTER_SECOND_RESTART");
      await expectSavedOnceAndCommitted("BEFORE_RESTART", "BETWEEN_RESTARTS", "AFTER_SECOND_RESTART");
    });

    it("a viewer's runner that waits for the status gives a call its runner, and follows the turn once the status reads", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      statusUnreadable = true;
      expect(await restartSweep("current-build", [])).toBe(0);

      const viewed = registry.getOrCreate(SESSION_ID, SESSION_DIR, "claude");
      viewed.attachViewer();
      viewed.detachViewer();
      expect(await agentRunFindsItsSession()).toBe(true);
      expect(runner()?.running).toBe(false);
      // The orphan-runner check reports a worker that stays unreachable.
      await waitFor(() => (viewed.workerStreamDownSince ?? 0) > 0, 3000, "the stream reads as down");

      statusUnreadable = false;
      await expectFollowed();
      expect(viewed.workerStreamDownSince).toBe(0);
      say("AFTER_RESTART");
      await expectSavedOnceAndCommitted("BEFORE_RESTART", "AFTER_RESTART");
    });

    it("the worker's report reaches a runner that waits for the status, and gets the answer following", async () => {
      ContainerSessionRunner.firstConnectRetryDelaysMs = [60_000];
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      statusReads = ["ok"];
      statusUnreadable = true;
      await restartSweep("current-build", []);
      expect(runner()?.running).toBe(false);

      statusUnreadable = false;
      expect(await ownTurnRoute()).toBe(true);
      await expectFollowed();
    });

    it("a call from the turn makes a waiting runner read the status at once", async () => {
      ContainerSessionRunner.firstConnectRetryDelaysMs = [60_000];
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      statusReads = ["ok"];
      statusUnreadable = true;
      await restartSweep("current-build", []);
      await waitFor(() => runner()?.waitingForWorkerStatus === true, 3000, "the runner waits");

      statusUnreadable = false;
      expect(await agentRunFindsItsSession()).toBe(true);
      expect(runner()?.running).toBe(true);
    });

    it("the idle reclaim does not take a runner that waits for the status", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      say("WHILE_DOWN");
      statusReads = ["ok"];
      statusUnreadable = true;
      await restartSweep("current-build", []);
      await waitFor(() => runner()?.waitingForWorkerStatus === true, 3000, "the runner waits");

      expect(runner()!.agentBusy).toBe(true);
      registry.dispose(SESSION_ID);
      expect(runner()?.disposed).toBe(false);

      statusUnreadable = false;
      await expectFollowed();
      say("AFTER_RESTART");
      await expectSavedOnceAndCommitted("BEFORE_RESTART", "WHILE_DOWN", "AFTER_RESTART");
    });

    it("a message sent while the runner waits is saved, though its turn ends before the status reads", async () => {
      await sentTurnOfThePreviousOrchestrator();
      endTurn();
      await previousOrchestratorStops();
      statusUnreadable = true;
      const waiting = registry.getOrCreate(SESSION_ID, SESSION_DIR, "claude");
      waiting.attachViewer();
      await waitFor(() => waiting.waitingForWorkerStatus === true, 3000, "the runner waits");

      waiting.dispatch(testDispatch({ text: "next task" }));
      await waitFor(() => agents.length === 2 && agents[1]!.runCalled, 3000, "the message started a turn");
      agents[1]!.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "NEXT_TEXT" }] });
      agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });

      statusUnreadable = false;
      await waitFor(() => commits.length === 1, 3000, "the message's turn is committed");
      expect(occurrences("NEXT_TEXT")).toBe(1);
      expect(waiting.running).toBe(false);
    });

    it("a kill while a status read is in flight is not undone by that read", async () => {
      ContainerSessionRunner.firstConnectRetryDelaysMs = [60_000];
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      statusReads = ["ok"];
      statusUnreadable = true;
      await restartSweep("current-build", []);
      const waiting = runner()!;
      await waitFor(() => waiting.waitingForWorkerStatus, 3000, "the runner waits");

      statusUnreadable = false;
      statusDelayMs = 300;
      const resumed = waiting.resumeInFlightTurn();
      await new Promise((r) => setTimeout(r, 100));
      await waiting.killAgentOnWorker();
      expect(agent().killed).toBe(true);

      expect(await resumed).toBe(false);
      say("LATE_OUTPUT");
      await new Promise((r) => setTimeout(r, 200));
      expect(waiting.running).toBe(false);
      expect(historyText()).not.toContain("LATE_OUTPUT");
    });

    it("a kill that a status read overlaps is not undone by that read", async () => {
      ContainerSessionRunner.firstConnectRetryDelaysMs = [60_000];
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      statusReads = ["ok"];
      statusUnreadable = true;
      await restartSweep("current-build", []);
      const waiting = runner()!;
      await waitFor(() => waiting.waitingForWorkerStatus, 3000, "the runner waits");

      // The read reaches the worker before the kill does, and its answer comes after the kill.
      statusUnreadable = false;
      killDelayMs = 100;
      statusDelayMs = 300;
      const killing = waiting.killAgentOnWorker();
      const resumed = waiting.resumeInFlightTurn();
      await killing;
      expect(agent().killed).toBe(true);

      expect(await resumed).toBe(false);
      expect(waiting.running).toBe(false);
    });

    it("a start that failed while the runner waited leaves the worker's resident to be followed", async () => {
      await sentTurnOfThePreviousOrchestrator();
      endTurn();
      await previousOrchestratorStops();
      statusUnreadable = true;
      refuseStarts = true;
      const waiting = registry.getOrCreate(SESSION_ID, SESSION_DIR, "claude");
      waiting.attachViewer();
      await waitFor(() => waiting.waitingForWorkerStatus === true, 3000, "the runner waits");

      waiting.dispatch(testDispatch({ text: "next task" }));
      await waitFor(() => waiting.running, 3000, "the message started a turn");
      await waitFor(() => !waiting.running, 3000, "the refused start ended it");
      refuseStarts = false;
      statusUnreadable = false;
      await waitFor(() => waiting.waitingForWorkerStatus === false, 3000, "the status reads");

      selfWake();
      await waitFor(() => waiting.running, 3000, "the resident's own turn is followed");
      expect(agents).toHaveLength(1);
    });

    it("a runner disposed while it reads the status again adopts nothing, and leaves the worker's turn alone", async () => {
      await sentTurnOfThePreviousOrchestrator();
      await previousOrchestratorStops();
      statusReads = ["ok"];
      statusUnreadable = true;
      await restartSweep("current-build", []);
      const disposed = runner()!;
      // The runner's next try reads a live turn, but the answer comes after the disposal.
      statusUnreadable = false;
      statusDelayMs = 300;
      await new Promise((r) => setTimeout(r, 100));
      registry.dispose(SESSION_ID, { force: true });

      await new Promise((r) => setTimeout(r, 500));
      expect(disposed.disposed).toBe(true);
      expect(disposed.running).toBe(false);
      expect(await disposed.resumeInFlightTurn()).toBe(false);
      expect(agent().killed).toBe(false);
    });

    it("a call from a session whose worker has no turn in flight still gets no runner", async () => {
      await sentTurnOfThePreviousOrchestrator();
      endTurn();
      await previousOrchestratorStops();
      await restartSweep();

      expect(await agentRunFindsItsSession()).toBe(false);
      expect(registry.size).toBe(0);
    });
  });
});
