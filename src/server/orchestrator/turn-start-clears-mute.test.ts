/**
 * docs/277 (req 4) — a mute ends when the session's next turn STARTS.
 *
 * The clear lives on `executeAgentTurn`'s first lines, beside the `track()` call
 * docs/233 put there, because that is the one point both the WS path and the
 * dispatch path (`shipit session message`, the CI-fix loop, a merge-wake, a
 * queue drain) run through. Moving it to a WS-only entry point, or to turn
 * *end*, is what this test bites on: a turn started by anything but a browser
 * would leave the session muted while it worked, and every "needs you" surface
 * would stay silent about whatever it produced.
 *
 * It also pins the broadcast, which is what makes the clear visible: the sidebar
 * derives attention from its own copy of the session list, so a mute cleared in
 * SQLite and never announced would keep the row quiet in every open tab until
 * some unrelated event refreshed the list.
 */
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

/**
 * Drives one dispatched turn to the point where the agent has been asked to run,
 * with `setMuted` stubbed to report whether the row changed. Returns the mute
 * calls and the SSE events emitted BEFORE the agent started — the window the
 * clear has to happen in.
 */
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
    // Every turn runs this line, so the unmuted case — which is nearly all of
    // them — must cost nothing on the wire.
    const { setMuted, eventsBeforeRun } = await startTurn(false);
    expect(setMuted).toHaveBeenCalledWith("s1", null);
    expect(eventsBeforeRun).not.toContain("session_list");
  });
});
