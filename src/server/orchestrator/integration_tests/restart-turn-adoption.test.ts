/**
 * Integration tests for turn adoption across an orchestrator restart (docs/240).
 *
 * The scenario, as observed in production: the orchestrator crashed and
 * restarted while agents were mid-turn. The session containers kept running —
 * the CLIs went on working and emitting into each worker's SSE ring buffer. The
 * restarted orchestrator rediscovered the containers and reconnected SSE, but
 * the `ProxyAgentProcess` every turn was bound to had died with the old process,
 * so every replayed event hit the `(no _agent)` drop branch. Sessions rendered
 * as stopped, the turns' transcript tails were never persisted, and
 * `postTurnCommit` → auto-push → PR card never ran.
 *
 * The harness models the restart honestly, with a REAL `SessionWorker` over
 * HTTP + SSE (no Docker):
 *
 *   1. Start a turn on the worker directly (`POST /agent/start`) and emit some
 *      of it — this is the pre-restart orchestrator's turn, and nothing is
 *      listening for it. Seed chat history with the partial `in_progress` rows
 *      that orchestrator had written before it died.
 *   2. Build a FRESH `ContainerSessionRunner` against the same worker — the
 *      restarted orchestrator — and reattach.
 *
 * Then assert the three things the bug cost us: the session comes back running,
 * the replayed turn lands in persisted history exactly once (the pre-crash
 * partial rows are replaced, not duplicated), and the post-turn commit flow
 * fires off the replayed `agent_result`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { DatabaseManager } from "../../shared/database.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type {
  AgentProcess,
  AgentProcessEvents,
  AgentId,
  AgentRunParams,
  PermissionMode,
  WorkerAgentStatus,
} from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Worker-side fake agent
// ---------------------------------------------------------------------------

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
    supportsSteering: true,
    supportsCompaction: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };
  runCalled = false;
  lastParams: AgentRunParams | null = null;
  sentMessages: string[] = [];
  killed = false;
  readonly isStreaming = true;

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }
  writeStdin(_data: string): void {}
  sendUserMessage(text: string): void { this.sentMessages.push(text); }
  interrupt(): void {}
  kill(): void { this.killed = true; }
  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(fn: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

const SESSION_ID = "restart-session";

describe("Integration: adopting a turn that outlived the orchestrator (docs/240)", () => {
  let worker: SessionWorker;
  let workerUrl: string;
  let lastAgent: FakeWorkerAgent;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let usageManager: UsageManager;
  let runners: ContainerSessionRunner[];
  let commits: { summary: string }[];
  let pushes: string[];
  let sseEvents: { event: string; data: unknown }[];

  beforeEach(async () => {
    lastAgent = null as unknown as FakeWorkerAgent;
    runners = [];
    commits = [];
    pushes = [];
    sseEvents = [];
    worker = new SessionWorker({
      agentFactory: () => {
        lastAgent = new FakeWorkerAgent();
        return lastAgent;
      },
      port: 0,
      host: "127.0.0.1",
    });
    const address = await worker.start();
    const port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
    workerUrl = `http://127.0.0.1:${port}`;

    dbManager = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    usageManager = new UsageManager(dbManager);
    sessionManager.track(SESSION_ID, "Restarted session", "/tmp/restart-session");
  });

  afterEach(async () => {
    for (const r of runners) r.dispose({ force: true });
    await worker.stop();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  /** A restarted orchestrator's runner for this session, fully wired. */
  function makeRunner(): ContainerSessionRunner {
    const runner = new ContainerSessionRunner({
      sessionId: SESSION_ID,
      sessionDir: "/tmp/restart-session",
      defaultAgentId: "claude",
      workerUrl,
    });
    const deps: SystemTurnDeps = {
      agentFactory: (agentId) => runner.createAgent(agentId),
      autoCommit: async () => ({
        commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null,
      }),
      scheduleAutoPush: (dir) => { pushes.push(dir); },
      commitTurn: async ({ summary, sessionDir }) => {
        commits.push({ summary });
        pushes.push(sessionDir);
        return "commit-hash-1";
      },
      buildRunParams: async (_sessionId, _agentId, prompt) => ({ prompt, cwd: "/workspace" }),
      listenerDeps: {
        sessionManager,
        chatHistoryManager,
        usageManager,
        sseBroadcast: (event, data) => { sseEvents.push({ event, data }); },
        broadcastLog: () => {},
        getSelectedModel: () => undefined,
      },
    };
    runner.setSystemTurnDeps(deps);
    runners.push(runner);
    return runner;
  }

  /**
   * Start a turn on the worker the way the PRE-restart orchestrator would have,
   * and emit its opening events into the ring buffer with nobody listening.
   */
  async function startPreRestartTurn(runToken = "pre-restart-token"): Promise<void> {
    const res = await fetch(`${workerUrl}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "claude",
        runToken,
        params: { prompt: "refactor the parser", cwd: "/workspace", useStreaming: true },
      }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => lastAgent?.runCalled, 2000, "worker started the agent");
    lastAgent.emit("event", {
      type: "agent_init",
      agentId: "claude",
      sessionId: "cli-session-1",
      model: "claude-sonnet-4-6",
      tools: [],
    });
    lastAgent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "MIDTURN_TEXT" }],
    });
  }

  /** The partial rows the crashed orchestrator had already written. */
  function seedPreCrashHistory(): void {
    chatHistoryManager.append(SESSION_ID, { role: "user", text: "refactor the parser" });
    chatHistoryManager.append(SESSION_ID, {
      role: "assistant",
      text: "MIDTURN_TEXT",
      inProgress: true,
    });
  }

  // ---- the worker's own report ----

  it("worker reports a turn as in flight until agent_result, separately from process residency", async () => {
    const idle = await (await fetch(`${workerUrl}/agent/status`)).json() as WorkerAgentStatus;
    expect(idle.running).toBe(false);
    expect(idle.turnActive).toBe(false);

    await startPreRestartTurn("token-abc");
    const live = await (await fetch(`${workerUrl}/agent/status`)).json() as WorkerAgentStatus;
    expect(live.turnActive).toBe(true);
    expect(live.runToken).toBe("token-abc");
    expect(live.agentId).toBe("claude");
    expect(live.streaming).toBe(true);
    // The replay anchor precedes the turn's own events.
    expect(live.turnStartSseSeq).toBeLessThan(live.latestSseSeq);

    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });
    const done = await (await fetch(`${workerUrl}/agent/status`)).json() as WorkerAgentStatus;
    // The streaming process stays RESIDENT, but the turn is over — the
    // distinction adoption depends on.
    expect(done.running).toBe(true);
    expect(done.turnActive).toBe(false);
  });

  // ---- adoption ----

  it("reattaches a live turn: the session comes back running and the replay lands", async () => {
    await startPreRestartTurn();
    seedPreCrashHistory();

    const runner = makeRunner();
    const adopted = await runner.resumeInFlightTurn();

    expect(adopted).toBe(true);
    expect(runner.running).toBe(true);
    // The replayed assistant event was routed into the adopted turn rather than
    // dropped `(no _agent)`.
    await waitFor(() => runner.accumulatedText.includes("MIDTURN_TEXT"), 3000, "replayed assistant text");
    expect(sseEvents.some((e) => e.event === "session_agent_started")).toBe(true);
  });

  it("persists the replayed turn exactly once, replacing the pre-crash partial rows", async () => {
    await startPreRestartTurn();
    seedPreCrashHistory();
    expect(chatHistoryManager.load(SESSION_ID)).toHaveLength(2);

    const runner = makeRunner();
    await runner.resumeInFlightTurn();
    await waitFor(() => runner.accumulatedText.includes("MIDTURN_TEXT"), 3000, "replay");

    // The agent finishes the turn AFTER the restart — the canonical signal the
    // whole post-turn flow keys off.
    lastAgent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: " and DONE_TEXT" }],
    });
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });
    await waitFor(() => !runner.running, 3000, "turn finished");

    const history = chatHistoryManager.load(SESSION_ID);
    // One user row (never re-persisted by the adoption — the pre-crash
    // orchestrator wrote it) and no duplicated assistant rows.
    expect(history.filter((m) => m.role === "user")).toHaveLength(1);
    const assistantText = history.filter((m) => m.role === "assistant").map((m) => m.text).join("");
    expect(assistantText).toContain("MIDTURN_TEXT");
    expect(assistantText).toContain("DONE_TEXT");
    // "MIDTURN_TEXT" appears once across the whole transcript — the pre-crash
    // in-progress row was replaced, not duplicated.
    const occurrences = history
      .map((m) => m.text ?? "")
      .join("\n")
      .split("MIDTURN_TEXT").length - 1;
    expect(occurrences).toBe(1);
    // Nothing is left flagged in-progress once the turn is finalized.
    expect(history.some((m) => m.inProgress)).toBe(false);
  });

  it("runs the post-turn commit + push flow off the replayed agent_result", async () => {
    await startPreRestartTurn();
    seedPreCrashHistory();

    const runner = makeRunner();
    await runner.resumeInFlightTurn();
    await waitFor(() => runner.accumulatedText.includes("MIDTURN_TEXT"), 3000, "replay");

    expect(commits).toHaveLength(0);
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });

    await waitFor(() => commits.length > 0, 3000, "post-turn commit");
    expect(commits).toHaveLength(1);
    expect(pushes).toContain("/tmp/restart-session");
  });

  it("keeps the adopted turn's run token so its agent_done is not ignored as a stale spawn", async () => {
    await startPreRestartTurn("token-xyz");
    seedPreCrashHistory();

    const runner = makeRunner();
    await runner.resumeInFlightTurn();
    await waitFor(() => runner.accumulatedText.includes("MIDTURN_TEXT"), 3000, "replay");

    // The CLI exits (container restart / crash) — the worker stamps the ORIGINAL
    // spawn's token onto `agent_done`. A freshly-minted token on the adopting
    // proxy would make `isStaleSpawnEvent` drop this and strand `running=true`.
    lastAgent.emit("done", 0);
    await waitFor(() => !runner.running, 3000, "done handled");
    expect(runner.isStreamingActive).toBe(false);
  });

  // ---- the cases adoption must NOT touch ----

  it("does not adopt (or replay) a turn that already finished before the restart", async () => {
    await startPreRestartTurn();
    lastAgent.emit("event", { type: "agent_result", status: "success", sessionId: "cli-session-1" });
    lastAgent.emit("done", 0);
    const status = await (await fetch(`${workerUrl}/agent/status`)).json() as WorkerAgentStatus;
    expect(status.running).toBe(false);
    expect(status.turnActive).toBe(false);

    const runner = makeRunner();
    const adopted = await runner.resumeInFlightTurn();

    expect(adopted).toBe(false);
    expect(runner.running).toBe(false);
    // The finished turn's buffered events were skipped, not re-attributed to
    // this runner (the post-restart double-render bug).
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.accumulatedText).toBe("");
    expect(commits).toHaveLength(0);
  });

  it("does not adopt a turn a live runner already owns (no double-wiring)", async () => {
    const runner = makeRunner();
    runner.attachViewer();
    await waitFor(() => !runner.running, 500).catch(() => {});

    // This runner starts its own turn — the normal path.
    const proxy = runner.createAgent("claude");
    proxy.run({ prompt: "hello", cwd: "/workspace" });
    await waitFor(() => lastAgent?.runCalled, 3000, "agent started");

    // A second resume must be a no-op: the slot is occupied by the live turn.
    const adopted = await runner.resumeInFlightTurn();
    expect(adopted).toBe(false);
    expect(runner.getAgent()).toBe(proxy);
  });
});
