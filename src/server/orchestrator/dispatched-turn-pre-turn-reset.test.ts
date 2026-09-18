import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import type { PreTurnResetHookResult } from "./pre-turn-reset-hook.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  flushTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";

function makeRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

function makeResetHook(over: Partial<PreTurnResetHookResult> = {}): {
  hook: (runner: unknown, sessionId: string, sessionDir: string) => Promise<PreTurnResetHookResult>;
  calls: { sessionId: string; sessionDir: string }[];
  delivered: string[];
} {
  const calls: { sessionId: string; sessionDir: string }[] = [];
  const delivered: string[] = [];
  const result: PreTurnResetHookResult = {
    agentPrefix: "[System] Your previous pull request (#482) was merged into main.",
    afterUserMessagePersisted: () => { delivered.push("anchor"); },
    ensureRecorded: () => { delivered.push("ensure"); },
    ...over,
  };
  return {
    hook: async (_runner, sessionId, sessionDir) => {
      calls.push({ sessionId, sessionDir });
      return result;
    },
    calls,
    delivered,
  };
}

describe("dispatched turn — pre-turn merged-branch reset (planning#333)", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  it("runs the reset for an Agent Interface SDK message and prefixes the prompt", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const { hook, calls } = makeResetHook();
    deps.preTurnReset = hook;
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({
      text: "Retry the failed import",
      agentInterface: { source: "agent_interface_sdk", surface: "preview" },
    }));
    await flushTurn();

    expect(calls).toEqual([{ sessionId: "s1", sessionDir: "/tmp/s1" }]);
    expect(promptSeen.startsWith("[System] Your previous pull request (#482) was merged into main.")).toBe(true);
    expect(promptSeen).toContain("Retry the failed import");
  });

  it("delivers the branch-updated record exactly once", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const { hook, delivered } = makeResetHook();
    deps.preTurnReset = hook;

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();

    // The real hook deduplicates delivery; this stub checks both triggers.
    expect(delivered).toContain("anchor");
    expect(delivered).toContain("ensure");
  });

  it("still delivers the record when the turn dies during setup", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const { hook, delivered } = makeResetHook();
    deps.preTurnReset = hook;
    deps.agentFactory = () => { throw new Error("container unreachable"); };

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    const outcome = await runner.dispatch(testDispatch({ text: "keep going" })).settled;

    expect(outcome.status).toBe("errored");
    expect(delivered).toEqual(["ensure"]);
  });

  it("runs once per dispatched message, not once per no-result retry", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const { hook, calls } = makeResetHook();
    deps.preTurnReset = hook;

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    agents[0]?.emit("done", 0);
    await flushTurn();

    expect(agents.length).toBeGreaterThan(1);
    expect(calls).toHaveLength(1);
  });

  it("skips a `postTurn: \"none\"` turn — a step inside the driver's own git operation", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const { hook, calls } = makeResetHook();
    deps.preTurnReset = hook;
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "resolve the conflicts", postTurn: "none", systemTurn: true }));
    await flushTurn();

    expect(calls).toHaveLength(0);
    expect(promptSeen).toBe("resolve the conflicts");
  });

  it("is a no-op when the runtime wires no hook (minimal setups)", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();

    expect(promptSeen).toBe("keep going");
  });
});

describe("dispatched turn — the parked sync notice (docs/221, nikzlabs/shipit#2349)", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  const NOTICE = "[System] While you were idle, this branch was rebased onto origin/main.";

  it("prefixes the prompt with the notice and consumes it exactly once", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    let remaining: string | undefined = NOTICE;
    const consumed: string[] = [];
    deps.consumePendingAgentNotice = (sessionId) => {
      consumed.push(sessionId);
      const value = remaining;
      remaining = undefined;
      return value;
    };
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "carry on" }));
    await flushTurn();

    expect(consumed).toEqual(["s1"]);
    expect(promptSeen.startsWith(NOTICE)).toBe(true);
    expect(promptSeen).toContain("carry on");
  });

  it("puts the notice ahead of a reset prefix — the sync happened first", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    deps.consumePendingAgentNotice = () => NOTICE;
    const { hook } = makeResetHook();
    deps.preTurnReset = hook;
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "carry on" }));
    await flushTurn();

    expect(promptSeen.indexOf(NOTICE)).toBe(0);
    expect(promptSeen.indexOf(NOTICE)).toBeLessThan(promptSeen.indexOf("was merged into main"));
  });

  it("does NOT consume it for a rebase-resolution turn (postTurn: none)", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const consumed: string[] = [];
    deps.consumePendingAgentNotice = (sessionId) => { consumed.push(sessionId); return NOTICE; };
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "resolve the conflicts", postTurn: "none", systemTurn: true }));
    await flushTurn();

    expect(consumed).toEqual([]);
    expect(promptSeen).toBe("resolve the conflicts");
  });

  it("puts the notice BACK when the turn dies before the agent sees it", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    deps.consumePendingAgentNotice = () => NOTICE;
    const reparked: { sessionId: string; notice: string }[] = [];
    deps.restorePendingAgentNotice = (sessionId, notice) => { reparked.push({ sessionId, notice }); };
    deps.agentFactory = () => { throw new Error("container unreachable"); };

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    const outcome = await runner.dispatch(testDispatch({ text: "carry on" })).settled;

    expect(outcome.status).toBe("errored");
    expect(reparked).toEqual([{ sessionId: "s1", notice: NOTICE }]);
  });

  it("does NOT put it back once the agent has the prompt", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    deps.consumePendingAgentNotice = () => NOTICE;
    const reparked: string[] = [];
    deps.restorePendingAgentNotice = (sessionId) => { reparked.push(sessionId); };

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "carry on" }));
    await flushTurn();

    expect(reparked).toEqual([]);
  });

  it("is a no-op when the runtime wires no consumer (minimal setups)", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();

    expect(promptSeen).toBe("keep going");
  });
});

describe("dispatched turn — a resolved bug-report card (nikzlabs/shipit#2350)", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  const FILED = [{
    cardId: "c1",
    phase: "filed" as const,
    title: "Preview won't reload",
    body: "b",
    stage2Ran: true,
    producer: "session" as const,
    issueNumber: 1234,
    issueUrl: "https://github.com/nikzlabs/shipit/issues/1234",
  }];

  it("prefixes the prompt with the outcome and consumes it exactly once", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    let remaining = FILED;
    const consumed: string[] = [];
    deps.consumeBugOutcomes = (sessionId) => {
      consumed.push(sessionId);
      const value = remaining;
      remaining = [];
      return value;
    };
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "carry on" }));
    await flushTurn();

    expect(consumed).toEqual(["s1"]);
    expect(promptSeen).toContain("FILED as issue #1234");
    expect(promptSeen).toContain("carry on");
  });

  it("does NOT consume it for a system turn — that is ShipIt talking to itself", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const consumed: string[] = [];
    deps.consumeBugOutcomes = (sessionId) => { consumed.push(sessionId); return FILED; };
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "fix CI", systemTurn: true }));
    await flushTurn();

    expect(consumed).toEqual([]);
    expect(promptSeen).not.toContain("FILED as issue");
  });

  it("is a no-op when the runtime wires no consumer (minimal setups)", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();

    expect(promptSeen).toBe("keep going");
  });
});
