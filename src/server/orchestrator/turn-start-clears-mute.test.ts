import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { AgentId, SessionInfo } from "../shared/types.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  return agent;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function startTurn(muteCleared: boolean): Promise<{
  setMuted: ReturnType<typeof vi.fn>;
  eventsBeforeRun: string[];
}> {
  const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
  const agents: FakeAgent[] = [];
  const events: string[] = [];
  let agentStarted = false;
  const eventsBeforeRun: string[] = [];

  const setMuted = vi.fn(() => (muteCleared ? ({ id: "s1" } as SessionInfo) : null));

  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      a.run.mockImplementation(() => {
        agentStarted = true;
        eventsBeforeRun.push(...events);
      });
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
    autoCommit: (async () => ({
      commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [],
    })) as never,
    scheduleAutoPush: vi.fn(),
    listenerDeps: {
      sessionManager: {
        setAgentSessionId: vi.fn(),
        setLastTurnErrored: vi.fn(),
        get: vi.fn(),
        track: vi.fn(),
        setMuted,
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
      sseBroadcast: vi.fn((event: string) => {
        if (!agentStarted) events.push(event);
      }),
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn().mockResolvedValue({ prompt: "do work", cwd: "/tmp/s1" }),
  };
  runner.setSystemTurnDeps(deps);

  runner.dispatch(testDispatch({ text: "do work" }));
  await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "agent run");
  runner.dispose({ force: true });
  return { setMuted, eventsBeforeRun };
}

describe("docs/277 — a started turn clears the mute", () => {
  it("clears the mute and broadcasts the new session list before the agent runs", async () => {
    const { setMuted, eventsBeforeRun } = await startTurn(true);
    expect(setMuted).toHaveBeenCalledWith("s1", null);
    expect(eventsBeforeRun).toContain("session_list");
  });

  it("does not broadcast when the session was not muted", async () => {
    const { setMuted, eventsBeforeRun } = await startTurn(false);
    expect(setMuted).toHaveBeenCalledWith("s1", null);
    expect(eventsBeforeRun).not.toContain("session_list");
  });
});
