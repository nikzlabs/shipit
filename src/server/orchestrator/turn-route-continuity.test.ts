import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

/**
 * docs/260-turn-level-account-routing req 8: a session stays on its account even when
 * its CLI process ended between turns. The resident route dies with the process, so
 * the turn must hand the router the account its previous turn ran on — without it,
 * `balanced` sent every such turn to the other account.
 */

type EnvOpts = Parameters<NonNullable<SystemTurnDeps["prepareAgentEnv"]>>[2];

function makeFakeAgent(): EventEmitter & { run: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  const agent = new EventEmitter() as EventEmitter & { run: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
  agent.run = vi.fn();
  agent.kill = vi.fn();
  return agent;
}

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function harness(lastRouteId: string | undefined) {
  const envCalls: EnvOpts[] = [];
  const agents: ReturnType<typeof makeFakeAgent>[] = [];
  const runner = new SessionRunner({
    sessionId: "s1",
    sessionDir: "/tmp/turn-route-continuity",
    defaultAgentId: "claude" as AgentId,
  });
  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
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
    prepareAgentEnv: async (_sessionId, _agentId, opts) => {
      envCalls.push(opts);
      return undefined;
    },
    listenerDeps: {
      sessionManager: {
        setAgentSessionId: vi.fn(),
        setLastTurnErrored: vi.fn(),
        get: (id: string) => ({ id }),
        track: vi.fn(),
        touchUnlessResolved: vi.fn(),
        setMuted: vi.fn(),
        list: () => [],
      } as never,
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        finalizeInProgress: vi.fn(),
        append: vi.fn(),
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: {
        record: vi.fn(),
        getSessionUsage: vi.fn(),
        getSessionTokenTotals: vi.fn(),
        lastTurnCredentialRouteId: () => lastRouteId,
      } as never,
      sseBroadcast: vi.fn(),
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn(async (_sessionId: string, _agentId: AgentId, prompt: string) => (
      { prompt, cwd: "/tmp/turn-route-continuity" }
    )) as never,
  };
  runner.setSystemTurnDeps(deps);
  return { runner, envCalls, agents };
}

async function runOneTurn(h: ReturnType<typeof harness>): Promise<void> {
  h.runner.dispatch(testDispatch({ text: "next step" }));
  await waitFor(() => h.agents.length === 1 && h.agents[0]!.run.mock.calls.length === 1, "the turn to start");
  h.agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
  h.agents[0]!.emit("done", 0);
  await waitFor(() => !h.runner.running, "the turn to finish");
  h.runner.dispose({ force: true });
}

describe("a turn keeps the session's account after its process ended (docs/260-turn-level-account-routing req 8)", () => {
  it("hands the router the account the previous turn ran on", async () => {
    const h = harness("acct-previous");
    await runOneTurn(h);

    expect(h.envCalls).toHaveLength(1);
    expect(h.envCalls[0]).toMatchObject({ previousRouteId: "acct-previous" });
    expect(h.envCalls[0]).not.toHaveProperty("residentRoute");
  });

  it("passes no previous account for a session that has never run a turn", async () => {
    const h = harness(undefined);
    await runOneTurn(h);

    expect(h.envCalls[0]).not.toHaveProperty("previousRouteId");
  });
});
