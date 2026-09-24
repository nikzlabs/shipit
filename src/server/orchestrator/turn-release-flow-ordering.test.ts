import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
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

async function waitFor(fn: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
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

// The release flow runs after the drain, so a queued successor can start — and
// finish — before the finished turn's release flow reads its text.
describe("release flow across a drained successor turn", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-release-order-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: dir, defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const releaseTexts: string[] = [];
    runner.setSystemTurnDeps({
      agentFactory: () => {
        const a = makeFakeAgent();
        agents.push(a);
        return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
      },
      autoCommit: vi.fn(),
      scheduleAutoPush: vi.fn(),
      commitTurn: vi.fn(async () => null),
      postTurnReleaseFlow: vi.fn(async (_sid: string, _dir: string, text: string) => {
        releaseTexts.push(text);
      }),
      listenerDeps: makeListenerDeps(),
      buildRunParams: vi.fn().mockResolvedValue({ prompt: "p", cwd: dir }),
    } as SystemTurnDeps);
    return { runner, agents, releaseTexts };
  }

  const say = (agent: FakeAgent, text: string) =>
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text }] });
  const result = (agent: FakeAgent) =>
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

  it("hands the finished turn its own text after the queued turn has reset the runner", async () => {
    const { runner, agents, releaseTexts } = setup();
    runner.dispatch(testDispatch({ text: "cut a release" }));
    await waitFor(() => agents[0]?.run.mock.calls.length === 1, "turn A started");
    runner.dispatch(testDispatch({ text: "Maybe 0.5.1?" }));

    say(agents[0]!, "MARKER-A");
    result(agents[0]!);
    await waitFor(() => agents[1]?.run.mock.calls.length === 1, "queued turn B started");
    agents[0]!.emit("done", 0);

    await waitFor(() => releaseTexts.length === 1, "turn A release flow ran");
    expect(releaseTexts).toEqual(["MARKER-A"]);
    runner.dispose({ force: true });
  });

  it("does not let the finished turn's older markers overwrite a successor that already ran", async () => {
    const { runner, agents, releaseTexts } = setup();
    runner.dispatch(testDispatch({ text: "cut a release" }));
    await waitFor(() => agents[0]?.run.mock.calls.length === 1, "turn A started");
    runner.dispatch(testDispatch({ text: "make it 0.5.2" }));

    say(agents[0]!, "MARKER-A");
    result(agents[0]!);
    await waitFor(() => agents[1]?.run.mock.calls.length === 1, "queued turn B started");

    say(agents[1]!, "MARKER-B");
    result(agents[1]!);
    agents[1]!.emit("done", 0);
    await waitFor(() => releaseTexts.length === 1, "turn B release flow ran");

    agents[0]!.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(releaseTexts).toEqual(["MARKER-B"]);
    runner.dispose({ force: true });
  });
});
