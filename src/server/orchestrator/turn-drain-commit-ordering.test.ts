import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import { GitManager } from "../shared/git.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(onRun?: () => void): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn(() => onRun?.());
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  return agent;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeListenerDeps(sseBroadcast = vi.fn()): SystemTurnDeps["listenerDeps"] {
  return {
    sessionManager: {
      setAgentSessionId: vi.fn(),
      setLastTurnErrored: vi.fn(),
      get: vi.fn(),
      track: vi.fn(),
      setMuted: vi.fn(),
      list: vi.fn().mockReturnValue([]),
    } as never,
    chatHistoryManager: {
      replaceInProgress: vi.fn(),
      finalizeInProgress: vi.fn(),
      append: vi.fn(),
      updateLastMessage: vi.fn().mockReturnValue(null),
      indexOfMessageId: vi.fn().mockReturnValue(-1),
    } as never,
    usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
    sseBroadcast,
    broadcastLog: vi.fn(),
    getSelectedModel: () => undefined,
  };
}

describe("queue drain vs. post-turn commit ordering (planning#264)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi262-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repoDir, "file.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "initial");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("commits the finished turn's edits BEFORE a queued turn that resets the working tree runs", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const filePath = path.join(repoDir, "file.txt");

    const onRunByTurn = [
      () => fs.writeFileSync(filePath, "turn-1 work\n"),
      () => execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoDir, stdio: "pipe" }),
    ];

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const idx = agents.length;
        const a = makeFakeAgent(() => onRunByTurn[idx]?.());
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: async (sessionDir: string, summary: string) => {
        const git = new GitManager(sessionDir);
        const parentHash = await git.getHeadHash();
        const r = await git.autoCommit(summary);
        return { ...r, parentHash };
      },
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");

    runner.dispatch(testDispatch({ text: "reset the tree" }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "turn 2 started");

    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");

    const log = execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" });
    expect(log.split("\n").filter(Boolean)).toHaveLength(2);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn 2 finished");
    runner.dispose({ force: true });
  });

  it("commits before the drain on the STREAMING branch too (post-turn flow runs off agent_result)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const filePath = path.join(repoDir, "file.txt");
    const onRunByTurn = [
      () => fs.writeFileSync(filePath, "turn-1 work\n"),
      () => execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoDir, stdio: "pipe" }),
    ];

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const idx = agents.length;
        const a = makeFakeAgent(() => onRunByTurn[idx]?.());
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: async (sessionDir: string, summary: string) => {
        const git = new GitManager(sessionDir);
        const parentHash = await git.getHeadHash();
        const r = await git.autoCommit(summary);
        return { ...r, parentHash };
      },
      scheduleAutoPush: vi.fn(),
      steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "make an edit" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    expect(runner.isStreamingActive).toBe(true);

    // A system turn queues instead of steering the streaming turn.
    runner.dispatch(testDispatch({ text: "reset the tree", systemTurn: true }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "turn 2 started");

    expect(fs.readFileSync(filePath, "utf8")).toBe("turn-1 work\n");

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    agents[0]!.emit("done", 0);
    await waitFor(() => !runner.running, "turns finished");
    runner.dispose({ force: true });
  });

  it("does not put a GitHub round-trip between two ordinary queued messages", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const order: string[] = [];
    let releasePrFlow: (() => void) | undefined;

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const idx = agents.length;
        const a = makeFakeAgent(() => order.push(`turn-${idx + 1}-started`));
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: async () => {
        order.push("commit");
        return { commitHash: "abc1234", parentHash: "def5678", conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null };
      },
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(() => {
        order.push("pr-flow-entered");
        return new Promise<void>((resolve) => { releasePrFlow = resolve; });
      }),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    runner.dispatch(testDispatch({ text: "second" }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "turn 2 started");

    expect(order.indexOf("turn-1-started")).toBe(0);
    expect(order.indexOf("commit")).toBeLessThan(order.indexOf("turn-2-started"));
    expect(deps.postTurnPrFlow).toHaveBeenCalledTimes(1);

    releasePrFlow?.();
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn 2 finished");
    releasePrFlow?.();
    runner.dispose({ force: true });
  });

  it("commits exactly once when a queued turn drains (the drain-time commit is reused by the PR flow)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const autoCommit = vi.fn(async () => ({
      commitHash: "abc1234", parentHash: "def5678", conflictedFiles: [], rebaseInProgress: false, secretFindings: [],
    }));
    const postTurnPrFlow = vi.fn(async () => {});

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: autoCommit as never,
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow,
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "first" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn 1 started");
    runner.dispatch(testDispatch({ text: "second" }));

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "turn 2 started");
    await waitFor(() => postTurnPrFlow.mock.calls.length === 1, "pr flow ran");

    expect(autoCommit).toHaveBeenCalledTimes(1);
    expect(postTurnPrFlow).toHaveBeenCalledWith("s1", repoDir, "abc1234", expect.any(Function));

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "turn 2 finished");
    runner.dispose({ force: true });
  });

  // planning#562 added a release when a system turn's hold comes off. The adapter-error path
  // reaches finishTurn BEFORE its drain and commit, so that release must not fire there.
  it("a system turn that ERRORS still commits before the queued turn that resets the tree runs", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const filePath = path.join(repoDir, "file.txt");

    const onRunByTurn = [
      () => fs.writeFileSync(filePath, "system-turn work\n"),
      () => execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoDir, stdio: "pipe" }),
    ];

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const idx = agents.length;
        const a = makeFakeAgent(() => onRunByTurn[idx]?.());
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: async (sessionDir: string, summary: string) => {
        const git = new GitManager(sessionDir);
        const parentHash = await git.getHeadHash();
        const r = await git.autoCommit(summary);
        return { ...r, parentHash };
      },
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "fix CI", systemTurn: true }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "system turn started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("system-turn work\n");

    // Background work is what defers the queued system turn at this turn's drain.
    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "Codex consult" }]);
    runner.dispatch(testDispatch({ text: "reset the tree", systemTurn: true }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("error", new Error("the CLI fell over"));

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "queued turn started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("system-turn work\n");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" });
    expect(log.split("\n").filter(Boolean)).toHaveLength(2);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "queued turn finished");
    runner.dispose({ force: true });
  });

  // The release is behind the local commit, not behind the drain: `drainFired` is set before
  // the commit it awaits, so an error landing in that window must not free the queue early.
  it("holds the release while the system turn's commit is still in flight", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const filePath = path.join(repoDir, "file.txt");
    const onRunByTurn = [
      () => fs.writeFileSync(filePath, "system-turn work\n"),
      () => execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoDir, stdio: "pipe" }),
    ];

    let releaseCommit = (): void => {};
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let commitStarted = false;

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const idx = agents.length;
        const a = makeFakeAgent(() => onRunByTurn[idx]?.());
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: async (sessionDir: string, summary: string) => {
        commitStarted = true;
        await commitGate;
        const git = new GitManager(sessionDir);
        const parentHash = await git.getHeadHash();
        const r = await git.autoCommit(summary);
        return { ...r, parentHash };
      },
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "fix CI", systemTurn: true }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "system turn started");

    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "Codex consult" }]);
    runner.dispatch(testDispatch({ text: "reset the tree", systemTurn: true }));
    expect(runner.queueLength).toBe(1);

    // The result opens the commit; the error then reaches finishTurn while it is still open.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => commitStarted, "commit started");
    agents[0]!.emit("error", new Error("the CLI fell over"));
    await flush();
    await flush();

    expect(agents).toHaveLength(1);
    expect(runner.queueLength).toBe(1);

    releaseCommit();
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "queued turn started");
    expect(fs.readFileSync(filePath, "utf8")).toBe("system-turn work\n");
    expect(execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" })
      .split("\n").filter(Boolean)).toHaveLength(2);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitFor(() => !runner.running, "queued turn finished");
    runner.dispose({ force: true });
  });

  it("leaves the empty-queue turn end untouched — the commit still runs after the finished SSE", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const order: string[] = [];
    const sseBroadcast = vi.fn((event: string) => {
      if (event === "session_agent_finished") order.push("finished");
    });

    const deps: SystemTurnDeps = {
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: (async () => {
        order.push("commit");
        return { commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [] };
      }) as never,
      scheduleAutoPush: vi.fn(),
      listenerDeps: makeListenerDeps(sseBroadcast),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "only turn" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");
    expect(runner.queueLength).toBe(0);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitFor(() => order.includes("commit"), "commit ran");

    expect(order).toEqual(["finished", "commit"]);

    runner.dispose({ force: true });
  });
});
