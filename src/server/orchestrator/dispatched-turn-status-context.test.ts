import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  flushTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";

const CARD = "<session_status_card>\nStatus:\nBilling service.\n</session_status_card>";

/**
 * docs/303 req 35 — a dispatched turn is a turn the agent can be asked to update the card
 * for (a wake, a CI fix, a cross-session message), so the card rides it too. The nudge is
 * the one exception: its own prompt already carries the card.
 */
describe("dispatched turn — the status card in the prompt (docs/303 req 35)", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  function setup() {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const prompts: string[] = [];
    deps.sessionStatusContext = () => CARD;
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      prompts.push(prompt);
      return { prompt, cwd: "/tmp/s1" } as never;
    });
    runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps(deps);
    return { prompts };
  }

  it("carries the card, with the message still last", async () => {
    const { prompts } = setup();
    runner.dispatch(testDispatch({ text: "Fix the failing build", systemTurn: true }));
    await flushTurn();

    expect(prompts[0]).toContain(CARD);
    expect(prompts[0]!.indexOf(CARD)).toBeLessThan(prompts[0]!.indexOf("Fix the failing build"));
  });

  it("leaves it out of the nudge, whose own prompt carries the same block", async () => {
    const { prompts } = setup();
    runner.dispatch(testDispatch({ text: "[ShipIt] update the card", systemTurn: true, statusNudge: true }));
    await flushTurn();

    expect(prompts[0]).not.toContain("<session_status_card>");
  });

  it("leaves it out of a driver-owned turn, which is never checked for an update", async () => {
    const { prompts } = setup();
    runner.dispatch(testDispatch({ text: "resolve the conflict", systemTurn: true, postTurn: "none" }));
    await flushTurn();

    expect(prompts[0]).not.toContain("<session_status_card>");
  });
});
