/**
 * The sub-agent spawn budget (`shipit agent run`, cap 3) is documented and named
 * as a PER-TURN budget. It used to be refilled in exactly one place —
 * `resetRunnerTurnState`, which only orchestrator-started turns call — so it
 * accumulated across every turn the orchestrator did not start.
 *
 * That is not a corner case. A self-woken turn (the CLI starting a turn when a
 * `Bash(run_in_background)` job finishes) runs through the PREVIOUS turn's
 * listeners, and `agent_self_wake` only calls `resetRunnerTurnState` when
 * `!runner.running` — a guard that must stay, because resetting mid-turn wipes
 * the running turn's chat-history accumulator (`integration_tests/
 * self-wake-midturn.test.ts`). Backgrounding a consult and being woken by it is
 * precisely the shape ShipIt's own guidance prescribes, so in a live session
 * three consecutive turns exhausted one budget of 3 and every later spawn was
 * refused with "Sub-agent spawn cap reached for this turn (max 3)" — permanently.
 *
 * The fix decouples the budget from the accumulator: `resetSubAgentSpawnBudget`
 * also runs where the CLI turn actually ENDS. These tests pin both halves — a
 * fresh budget per CLI turn, and a mid-turn notification that still refills
 * nothing and still leaves the accumulator alone.
 *
 * Harness mirrors `turn-self-wake-commit.test.ts`: the real executor in-process
 * against a real git repo, with a fake agent standing in for the CLI.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionRunner, resetSubAgentSpawnBudget } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import { executeAgentTurn } from "./turn-executor.js";
import type { AgentId } from "../shared/types.js";
import { GitManager } from "../shared/git.js";
import { SUB_AGENT_PER_TURN_CAP } from "./services/sub-agent.js";

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  agent.sendUserMessage = vi.fn();
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

describe("sub-agent spawn budget across turn boundaries", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "shi-budget-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
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

  async function startStreamingTurn() {
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    const agent = makeFakeAgent();
    const deps: SystemTurnDeps = {
      agentFactory: () => agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>,
      autoCommit: async (sessionDir: string, summary: string) => {
        const git = new GitManager(sessionDir);
        const parentHash = await git.getHeadHash();
        return { ...(await git.autoCommit(summary)), parentHash };
      },
      scheduleAutoPush: vi.fn(),
      postTurnPrFlow: vi.fn(async () => {}),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: repoDir }),
    };

    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "background a codex consult",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "turn started");
    return { runner, agent };
  }

  /** The reported bug: consecutive self-woken turns sharing one budget. */
  it("refills the budget for each CLI turn, including self-woken ones", async () => {
    const { runner, agent } = await startStreamingTurn();
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    // Turn 1 spends the whole budget on backgrounded consults, then ends.
    runner.subAgentSpawnsThisTurn = SUB_AGENT_PER_TURN_CAP;
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flush();
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    // A consult finishes and the CLI wakes itself. `resetRunnerTurnState` runs
    // here (nothing in flight), but the wake turn must have a budget either way.
    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    await flush();
    await flush();
    expect(runner.running).toBe(true);
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    // The wake turn spends its own budget and ends. A THIRD turn — the one the
    // live session was refused on — must still get a full budget.
    runner.subAgentSpawnsThisTurn = SUB_AGENT_PER_TURN_CAP;
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flush();
    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    runner.dispose({ force: true });
  });

  /**
   * The other half of the fix: a `task_notification` arriving MID-turn is not a
   * turn boundary. It must neither refill the budget (that would let an agent
   * top itself up by finishing a trivial background job, defeating the cap
   * inside a single turn) nor touch the accumulator.
   */
  it("does not refill the budget on a mid-turn task notification", async () => {
    const { runner, agent } = await startStreamingTurn();

    runner.subAgentSpawnsThisTurn = 2;
    runner.chatMessageGroups = [{ text: "GROUP-ONE", toolUse: [] }] as never;

    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    await flush();
    await flush();

    expect(runner.running).toBe(true);
    expect(runner.subAgentSpawnsThisTurn).toBe(2);
    // The running turn's transcript accumulator is untouched — the invariant
    // `integration_tests/self-wake-midturn.test.ts` guards, restated here so a
    // future budget change can't reach for `resetRunnerTurnState` instead.
    expect(runner.chatMessageGroups).toHaveLength(1);

    runner.dispose({ force: true });
  });

  /** A turn that died still ended: the next one must not inherit its spend. */
  it("refills the budget when the agent process errors", async () => {
    const { runner, agent } = await startStreamingTurn();

    runner.subAgentSpawnsThisTurn = SUB_AGENT_PER_TURN_CAP;
    agent.emit("error", new Error("boom"));
    await flush();
    await flush();

    expect(runner.subAgentSpawnsThisTurn).toBe(0);

    runner.dispose({ force: true });
  });

  it("resetSubAgentSpawnBudget clears only the budget", () => {
    const runner = new SessionRunner({
      sessionId: "s2",
      sessionDir: repoDir,
      defaultAgentId: "claude" as AgentId,
    });
    runner.subAgentSpawnsThisTurn = 3;
    runner.chatMessageGroups = [{ text: "KEEP", toolUse: [] }] as never;

    resetSubAgentSpawnBudget(runner);

    expect(runner.subAgentSpawnsThisTurn).toBe(0);
    expect(runner.chatMessageGroups).toHaveLength(1);

    runner.dispose({ force: true });
  });
});
