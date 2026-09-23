import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import { executeAgentTurn } from "./turn-executor.js";
import { createPromptRepark } from "./turn-settlement.js";
import type { AgentId } from "../shared/types.js";

/**
 * planning#609 — WHERE in the terminal sequence a take goes back, which the end state
 * cannot show. A drained successor is a different turn and composes its own prompt, so a
 * take still spent when the drain runs is one that turn does not get. The queued message
 * is exactly the one that needs to be told its branch moved.
 */

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  submissionSettled?: () => Promise<void>;
}

function makeFakeAgent(opts: { confirmsSubmission: boolean }): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  // A proxied submission answers separately from the process's own events, so a worker
  // that never answers leaves the prompt unconfirmed however the process then ends.
  agent.submissionSettled = opts.confirmsSubmission
    ? () => Promise.resolve()
    : () => new Promise<void>(() => { /* the worker never answers */ });
  return agent;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

function makeDeps(): SystemTurnDeps {
  return {
    agentFactory: (() => makeFakeAgent({ confirmsSubmission: true })) as never,
    autoCommit: async () => ({
      commitHash: null,
      parentHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [],
      unreadable: null,
      hookFailure: null,
    }),
    scheduleAutoPush: vi.fn(),
    listenerDeps: {
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
      sseBroadcast: vi.fn(),
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: (async (_sid: string, _agentId: AgentId, prompt: string) => ({
      prompt,
      cwd: "/tmp/s1",
    })) as never,
  };
}

describe("a take goes back before the drain, not after it (planning#609)", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  const run = async (opts: { confirmsSubmission: boolean }): Promise<string[]> => {
    const log: string[] = [];
    runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude" as AgentId,
    });
    const deps = makeDeps();
    runner.setSystemTurnDeps(deps);
    const agent = makeFakeAgent(opts);

    const turn = executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "[System] Your branch was reset to origin/main.\n\nnow add the rate limiter",
      userText: "now add the rate limiter",
      emitUserEcho: false,
      persistUserMessage: () => { /* not under test */ },
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: async () => { log.push("drain"); },
      emit: () => { /* not under test */ },
      // The real repark, so its latch is under test too: the executor reaches the call
      // twice on this path and the take must go back exactly once.
      promptReparks: [createPromptRepark("the test take", () => { log.push("repark"); })],
    });
    await flush();

    agent.emit("done", 0);
    await turn;
    for (let i = 0; i < 10; i += 1) await flush();
    return log;
  };

  it("reparks before the drain when the process dies with the prompt unconfirmed", async () => {
    const log = await run({ confirmsSubmission: false });
    // Settling and draining happen in one sequence, and the drain is sequenced first
    // (`turn-executor.ts`, the `done` handler). Reparking only at settlement therefore
    // restores the take one turn too late to be of any use to the turn that drained.
    expect(log).toEqual(["repark", "drain"]);
  });

  it("reparks nothing when the worker confirmed the prompt", async () => {
    // The agent read it; putting it back would tell the next turn a second time.
    expect(await run({ confirmsSubmission: true })).toEqual(["drain"]);
  });
});
