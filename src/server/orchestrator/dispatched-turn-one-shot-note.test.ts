import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import { ONE_SHOT_TURN_NOTE } from "./dispatched-turn.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  flushTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";

// docs/235 §9 — a turn that ShipIt starts can run on a process that exits when the message ends.
describe("dispatched turn — the one-shot note in the prompt", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  function setup(agentId: AgentId = "claude" as AgentId, opts: { steering?: boolean } = {}) {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    if (opts.steering) deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    const prompts: string[] = [];
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      prompts.push(prompt);
      return { prompt, cwd: "/tmp/s1" } as never;
    });
    runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: agentId });
    runner.setSystemTurnDeps(deps);
    return { prompts };
  }

  it("rides a turn that ShipIt started, ahead of the message", async () => {
    const { prompts } = setup();
    runner.dispatch(testDispatch({ text: "Your PR #7 merged.", automatic: true }));
    await flushTurn();

    expect(ONE_SHOT_TURN_NOTE).not.toBe("");
    expect(prompts[0]).toContain(ONE_SHOT_TURN_NOTE);
    expect(prompts[0]!.indexOf(ONE_SHOT_TURN_NOTE)).toBeLessThan(prompts[0]!.indexOf("Your PR #7 merged."));
  });

  it("stays off a turn that ShipIt did not start", async () => {
    const { prompts } = setup();
    runner.dispatch(testDispatch({ text: "A message from the parent session" }));
    await flushTurn();

    expect(prompts[0]).not.toContain(ONE_SHOT_TURN_NOTE);
  });

  // docs/329-user-steers-every-turn — a wake is no longer a system turn, and the note follows the process.
  it("rides a wake that will run on a one-shot process", async () => {
    const { prompts } = setup();
    runner.dispatch(testDispatch({ text: "Your PR #7 merged.", automatic: true, unattended: true }));
    await flushTurn();

    expect(prompts[0]).toContain(ONE_SHOT_TURN_NOTE);
  });

  it("stays off a wake that will run on a streaming process", async () => {
    const { prompts } = setup("claude" as AgentId, { steering: true });
    runner.dispatch(testDispatch({ text: "Your PR #7 merged.", automatic: true, unattended: true }));
    await flushTurn();

    expect(prompts[0]).toBe("Your PR #7 merged.");
  });

  it("stays off a driver-owned turn", async () => {
    const { prompts } = setup();
    runner.dispatch(testDispatch({ text: "resolve the conflicts", automatic: true, postTurn: "none" }));
    await flushTurn();

    expect(prompts[0]).toBe("resolve the conflicts");
  });

  it("stays off a harness that starts no turn for a finished background job", async () => {
    const { prompts } = setup("codex" as AgentId);
    runner.dispatch(testDispatch({ text: "Your PR #7 merged.", automatic: true }));
    await flushTurn();

    expect(prompts[0]).not.toContain(ONE_SHOT_TURN_NOTE);
  });
});
