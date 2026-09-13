import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  flushTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";

const NOTICE = "[System] Your previous pull request (#482) was merged into main.";

function makeRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

/** deps plus the takes a command turn must leave alone, and the prompt that reached the agent. */
function setup(): {
  deps: ReturnType<typeof makeDispatchTurnDeps>["deps"];
  agents: FakeAgent[];
  prompt: () => string;
  resetCalls: () => number;
  noticeTaken: () => number;
  roleTaken: () => number;
  bugOutcomesTaken: () => number;
} {
  const agents: FakeAgent[] = [];
  const { deps } = makeDispatchTurnDeps(agents, []);
  let resets = 0;
  let notices = 0;
  let roles = 0;
  let bugOutcomes = 0;
  let seen = "";
  deps.preTurnReset = async () => {
    resets += 1;
    return { agentPrefix: NOTICE };
  };
  deps.consumePendingAgentNotice = () => { notices += 1; return "The branch was reset."; };
  deps.takeRoleInstructions = () => { roles += 1; return "<role_instructions>Read first.</role_instructions>"; };
  deps.consumeBugOutcomes = () => {
    bugOutcomes += 1;
    return [{
      cardId: "card-1",
      phase: "filed" as const,
      title: "Preview never reloads",
      body: "steps to reproduce",
      stage2Ran: true,
      producer: "session" as const,
      issueNumber: 7,
      issueUrl: "https://example.test/7",
    }];
  };
  deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt: string) => {
    seen = prompt;
    return { prompt, cwd: "/tmp/s1" } as never;
  });
  return {
    deps,
    agents,
    prompt: () => seen,
    resetCalls: () => resets,
    noticeTaken: () => notices,
    roleTaken: () => roles,
    bugOutcomesTaken: () => bugOutcomes,
  };
}

describe("dispatched turn — a command invocation arrives alone (docs/299)", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  it("delivers the command with nothing added, and consumes none of the takes", async () => {
    const t = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(t.deps);

    runner.dispatch(testDispatch({ text: "/code-review high", dictated: true }));
    await flushTurn();

    expect(t.prompt()).toBe("/code-review high");
    // Each of these is a take or an action with no second chance this turn.
    expect(t.noticeTaken()).toBe(0);
    expect(t.roleTaken()).toBe(0);
    expect(t.bugOutcomesTaken()).toBe(0);
    expect(t.resetCalls()).toBe(0);
  });

  it("still prefixes an ordinary message, so the notices are not disabled", async () => {
    const t = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(t.deps);

    runner.dispatch(testDispatch({ text: "review the auth module" }));
    await flushTurn();

    expect(t.prompt()).toContain("The branch was reset.");
    expect(t.prompt()).toContain(NOTICE);
    expect(t.prompt()).toContain("review the auth module");
    expect(t.noticeTaken()).toBe(1);
    expect(t.roleTaken()).toBe(1);
    expect(t.bugOutcomesTaken()).toBe(1);
  });

  it("keeps the origin wrapper on a sibling session's message rather than running it as a command", async () => {
    const t = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(t.deps);

    runner.dispatch(testDispatch({
      text: "/goal ship the release",
      messageOrigin: { sessionId: "other", sessionTitle: "Sibling", relation: "sibling" },
    }));
    await flushTurn();

    // Dropping the wrapper to make the command reach the CLI alone would lose
    // where the message came from — the loss this doc exists to prevent.
    expect(t.prompt()).not.toBe("/goal ship the release");
    expect(t.prompt()).toContain("/goal ship the release");
    expect(t.prompt()).toContain("Sibling");
  });
});
