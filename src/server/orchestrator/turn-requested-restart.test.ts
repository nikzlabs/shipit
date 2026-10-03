// docs/321-agent-requested-restart — where the requested-restart step sits in a turn's
// terminal sequence, on each way a turn can end.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import { executeAgentTurn } from "./turn-executor.js";
import type { AgentId } from "../shared/types.js";
import { GitManager } from "../shared/git.js";
import type { RequestedRestartTurn } from "./services/agent-restart-request.js";

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

function makeListenerDeps(): SystemTurnDeps["listenerDeps"] {
  return {
    sessionManager: {
      setAgentSessionId: vi.fn(),
      setLastTurnErrored: vi.fn(),
      get: vi.fn(),
      track: vi.fn(),
      touchUnlessResolved: vi.fn(),
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
    sseBroadcast: vi.fn(),
    broadcastLog: vi.fn(),
    getSelectedModel: () => undefined,
  };
}

const realAutoCommit = async (sessionDir: string, summary: string) => {
  const git = new GitManager(sessionDir);
  const parentHash = await git.getHeadHash();
  const r = await git.autoCommit(summary);
  return { ...r, parentHash };
};

describe("the requested-restart step in a turn's terminal sequence", () => {
  let repoDir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  const commitCount = () =>
    execFileSync("git", ["log", "--oneline"], { cwd: repoDir, encoding: "utf8" })
      .split("\n")
      .filter(Boolean).length;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi321-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
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

  function setup(opts: { postTurn?: "none"; systemTurn?: boolean; settleInStep?: boolean } = {}) {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: repoDir, defaultAgentId: "claude" as AgentId });
    const events: string[] = [];
    const seen: { turn: RequestedRestartTurn; commits: number; ownsHold: boolean; current: boolean }[] = [];
    runner.on("idle", () => events.push("idle"));
    const onTurnComplete = vi.fn();
    const agent = makeFakeAgent(() => fs.writeFileSync(path.join(repoDir, "file.txt"), "the turn's work\n"));

    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: realAutoCommit,
      scheduleAutoPush: vi.fn(),
      // Production's commit defers the push arm until the PR flow's own push is done.
      commitTurn: async ({ sessionDir, summary, deferPushArm }) => {
        const r = await realAutoCommit(sessionDir, summary);
        if (r.commitHash) deferPushArm?.(() => { events.push("push-armed"); });
        return r.commitHash;
      },
      postTurnPrFlow: async () => { events.push("pr-flow"); },
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
      runRequestedRestart: async (turn) => {
        events.push("requested-restart");
        if (opts.settleInStep) turn.settle();
        seen.push({
          turn,
          commits: commitCount(),
          ownsHold: turn.ownsSystemHold(),
          current: turn.turnIsCurrent(),
        });
      },
    };

    const start = (useStreaming: boolean) =>
      executeAgentTurn(runner, deps, agent as never, {
        agentId: "claude" as AgentId,
        sessionId: "s1",
        prompt: "p",
        userText: "make an edit",
        emitUserEcho: false,
        persistUserMessage: vi.fn(),
        isNewSession: false,
        fallbackTitle: "t",
        turnStartHeadHash: null,
        drainNext: async () => {},
        emit: () => {},
        useStreaming,
        emitErrorOnNoResult: true,
        ...(opts.postTurn ? { postTurn: opts.postTurn } : {}),
        ...(opts.systemTurn ? { systemTurn: true } : {}),
        onTurnComplete,
      });

    return { runner, agent, events, seen, start, onTurnComplete };
  }

  it("runs after the commit, the PR flow and the push, and before idle", async () => {
    const { runner, agent, events, seen, start } = setup();
    await start(true);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => events.includes("idle"), "idle");

    expect(events).toEqual(["pr-flow", "push-armed", "requested-restart", "idle"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.commits).toBe(2);
    expect(seen[0]!.current).toBe(true);
    expect(seen[0]!.turn.runner).toBe(runner);
    runner.dispose({ force: true });
  });

  it("the step's settle reports the turn once, with its real outcome", async () => {
    const { runner, agent, seen, start, onTurnComplete } = setup({ settleInStep: true });
    await start(false);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agent.emit("done", 0);
    await waitFor(() => seen.length === 1, "requested-restart step");
    await flush();
    await flush();

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete.mock.calls[0]![0]).toMatchObject({ status: "completed" });
    runner.dispose({ force: true });
  });

  it("runs when the user pressed Stop (req 2)", async () => {
    const { runner, agent, seen, start } = setup();
    await start(false);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    runner.wasInterrupted = true;
    agent.emit("done", 143);
    await waitFor(() => seen.length === 1, "requested-restart step");

    expect(seen[0]!.commits).toBe(2);
    runner.dispose({ force: true });
  });

  it("runs when the agent process crashed", async () => {
    const { runner, agent, seen, start } = setup();
    await start(true);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("done", 137);
    await waitFor(() => seen.length === 1, "requested-restart step");
    runner.dispose({ force: true });
  });

  it("tells the step that a system turn still owns its hold, so the hold is not read as another flow's", async () => {
    const { runner, agent, seen, start } = setup({ systemTurn: true });
    await start(true);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => seen.length === 1, "requested-restart step");

    expect(runner.systemTurnInProgress).toBe(true);
    expect(seen[0]!.ownsHold).toBe(true);
    runner.dispose({ force: true });
  });

  it("does not run inside a flow that owns the tree (postTurn none)", async () => {
    const { runner, agent, seen, start } = setup({ postTurn: "none" });
    await start(true);
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");

    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flush();
    await flush();

    expect(seen).toHaveLength(0);
    runner.dispose({ force: true });
  });
});
