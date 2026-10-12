import { describe, it, expect, afterEach, vi } from "vitest";
import { SessionRunner } from "./session-runner.js";
import { takeSessionHold } from "./session-hold.js";
import type { AgentId, AgentProcess } from "../shared/types.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  makeFakeAgent,
  waitForTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";
import { noteTurnReady } from "./turn-stop-request.js";

describe("takeSessionHold", () => {
  it("releases only the hold that is set", () => {
    const runner: { sessionHold: ReturnType<typeof takeSessionHold> | null } = { sessionHold: null };
    const first = takeSessionHold(runner);
    expect(runner.sessionHold).toBe(first);

    const second = takeSessionHold(runner);
    first.release();
    expect(runner.sessionHold).toBe(second);

    second.release();
    expect(runner.sessionHold).toBeNull();
    second.release();
    expect(runner.sessionHold).toBeNull();
  });
});

// docs/329-user-steers-every-turn — the lock is the flow's; the gate admits the flow's own step.
describe("the dispatch gate under a session hold", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  function setup(): { agents: FakeAgent[] } {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps(deps);
    return { agents };
  }

  it("queues a dispatch that names no hold, and refuses one that may not wait", () => {
    setup();
    takeSessionHold(runner);

    expect(runner.dispatch(testDispatch({ text: "typed" })).admitted).toBe("queued");
    expect(runner.dispatch(testDispatch({ text: "a step" }), { whenBusy: "refuse" }).admitted).toBe("refused");
    expect(runner.running).toBe(false);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["typed"]);
  });

  it("admits the step of the flow that holds the session", async () => {
    const { agents } = setup();
    const hold = takeSessionHold(runner);

    const step = runner.dispatch(
      testDispatch({ text: "resolve the conflicts", postTurn: "none" }),
      { whenBusy: "refuse", underHold: hold },
    );

    expect(step.admitted).toBe("started");
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the step started");
    expect(runner.sessionHold).toBe(hold);
  });

  it("refuses the step of a flow whose hold was released or taken over", () => {
    setup();
    const released = takeSessionHold(runner);
    released.release();
    expect(
      runner.dispatch(testDispatch({ text: "late step" }), { whenBusy: "refuse", underHold: released }).admitted,
    ).toBe("refused");

    const replaced = takeSessionHold(runner);
    takeSessionHold(runner);
    expect(
      runner.dispatch(testDispatch({ text: "late step" }), { whenBusy: "refuse", underHold: replaced }).admitted,
    ).toBe("refused");
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(0);
  });

  it("ends an idle resident for the step only when it admits the step", async () => {
    const { agents } = setup();
    const resident = makeFakeAgent();
    runner.setAgent(resident as unknown as AgentProcess);
    runner.isStreamingActive = true;
    const step = () => testDispatch({ text: "resolve the conflicts", postTurn: "none" });

    const released = takeSessionHold(runner);
    released.release();
    expect(runner.dispatch(step(), { whenBusy: "refuse", underHold: released }).admitted).toBe("refused");
    expect(resident.kill).not.toHaveBeenCalled();
    expect(runner.getAgent()).toBe(resident as unknown as AgentProcess);

    const hold = takeSessionHold(runner);
    expect(runner.dispatch(step(), { whenBusy: "refuse", underHold: hold }).admitted).toBe("started");
    expect(resident.kill).toHaveBeenCalled();
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the step started on a process of its own");
    expect(resident.sendUserMessage).not.toHaveBeenCalled();
  });

  it("lets a message steer the turn that runs under the hold", async () => {
    const { agents } = setup();
    const hold = takeSessionHold(runner);
    runner.dispatch(testDispatch({ text: "resolve the conflicts", postTurn: "none" }), { whenBusy: "refuse", underHold: hold });
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the step started");
    noteTurnReady(runner);

    const steer = runner.dispatch(testDispatch({ text: "keep both edits" }));

    expect(steer.admitted).toBe("steered");
    expect(agents[0]!.sendUserMessage).toHaveBeenCalledWith("keep both edits");
  });
});
