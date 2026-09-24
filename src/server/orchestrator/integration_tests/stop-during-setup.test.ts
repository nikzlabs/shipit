import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import type { TurnOutcome } from "../turn-settlement.js";
import { handleInterruptAgent } from "../ws-handlers/misc-handlers.js";
import {
  makeDispatchTurnDeps,
  testDispatch,
  waitForTurn,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

/** A Stop pressed before the agent process exists must still stop the turn. */

let runner: SessionRunner;
let agents: FakeAgent[];
let deps: SystemTurnDeps;
let settled: TurnOutcome[];

beforeEach(() => {
  agents = [];
  settled = [];
  sent = [];
  deps = makeDispatchTurnDeps(agents, []).deps;
  runner = new SessionRunner({
    sessionId: "sess-1",
    sessionDir: "/tmp/s1",
    defaultAgentId: "claude" as AgentId,
  });
  runner.setSystemTurnDeps(deps);
});

afterEach(() => {
  runner.dispose({ force: true });
  vi.restoreAllMocks();
});

/** Hold the next turn in env preparation until the returned release is called. */
function holdSetup(): { began: () => boolean; release: () => void } {
  let began = false;
  let release: () => void = () => {};
  (deps.prepareAgentEnv as unknown) = vi.fn(async () => {
    began = true;
    await new Promise<void>((resolve) => { release = resolve; });
    return undefined;
  });
  return { began: () => began, release: () => { release(); } };
}

let sent: unknown[] = [];

function pressStop(): void {
  const ctx = {
    getActiveAppSessionId: () => "sess-1",
    getRunnerRegistry: () => ({ get: () => runner }),
    getRunner: () => runner,
    send: (msg: unknown) => { sent.push(msg); },
    broadcastLog: vi.fn(),
  };
  handleInterruptAgent(ctx as unknown as Parameters<typeof handleInterruptAgent>[0]);
}

function dispatch(text: string): void {
  runner.dispatch(testDispatch({ text, onTurnComplete: (outcome) => { settled.push(outcome); } }));
}

describe("Stop during turn setup", () => {
  it("never spawns the agent and settles the turn as interrupted", async () => {
    const setup = holdSetup();
    dispatch("do something");
    await waitForTurn(setup.began, "env preparation");

    const agent = agents[0]!;
    pressStop();
    expect(sent).toEqual([]);
    setup.release();

    await waitForTurn(() => settled.length === 1, "turn settled");
    expect(agent.run).not.toHaveBeenCalled();
    expect(settled[0]!.status).toBe("interrupted");
    expect(runner.running).toBe(false);
  });

  it("does not send to a resident process, and ends it", async () => {
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    dispatch("first");
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "resident agent running");
    const resident = agents[0]!;
    resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => !runner.running, "first turn finished");

    const setup = holdSetup();
    dispatch("second");
    await waitForTurn(setup.began, "env preparation");
    expect(agents).toHaveLength(1);

    pressStop();
    expect(resident.kill).not.toHaveBeenCalled();
    setup.release();

    await waitForTurn(() => resident.kill.mock.calls.length === 1, "resident killed");
    expect(resident.sendUserMessage).not.toHaveBeenCalled();
    resident.emit("done", 143);
    await waitForTurn(
      () => settled.some((o) => o.status === "interrupted"),
      "second turn settled as interrupted",
    );
    expect(runner.getAgent()).toBeNull();
  });

  it("stops a turn that has no agent yet", async () => {
    let releaseReset: () => void = () => {};
    let resetBegan = false;
    (deps.preTurnReset as unknown) = vi.fn(async () => {
      resetBegan = true;
      await new Promise<void>((resolve) => { releaseReset = resolve; });
      return { agentPrefix: "" };
    });
    dispatch("do something");
    await waitForTurn(() => resetBegan, "pre-turn reset");
    expect(agents).toHaveLength(0);

    pressStop();
    expect(sent).toEqual([]);
    releaseReset();

    await waitForTurn(() => settled.length === 1, "turn settled");
    expect(agents.every((a) => a.run.mock.calls.length === 0)).toBe(true);
    expect(settled[0]!.status).toBe("interrupted");
  });

  it("signals the process once the prompt is submitted", async () => {
    dispatch("do something");
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "agent running");
    const interrupt = vi.fn();
    (agents[0] as FakeAgent & { interrupt: () => void }).interrupt = interrupt;

    pressStop();
    expect(interrupt).toHaveBeenCalledTimes(1);
  });
});
