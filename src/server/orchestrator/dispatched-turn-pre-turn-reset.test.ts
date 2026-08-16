/**
 * planning#333 — a programmatic message continues on the SAME fresh base a typed
 * message would.
 *
 * docs/218 wired the merged-branch auto-reset into the interactive path only,
 * on the reasoning that a destructive reset underneath an automated message
 * would surprise. The Agent Interface SDK (docs/242) made that boundary wrong:
 * a click inside a page the agent built is the user continuing the session, it
 * arrives as a dispatch, and the turn ran on a branch still sitting on
 * already-merged commits — no reset, no prefix, and no "Branch updated" card.
 *
 * These drive the REAL `SessionRunner.dispatch` → `runDispatchedTurn` path with
 * a stubbed hook, so what is under test is the wiring: called once per message,
 * prefix in front of the prompt the agent actually runs, and the transcript
 * record delivered on both the healthy and the dying turn.
 */
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

/** A stub hook that records its calls and reports both delivery triggers. */
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
    // The prompt the agent runs is whatever the adapter hands `buildRunParams`.
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

    // Both triggers run (anchor during the turn, `ensureRecorded` in the
    // `finally`); the real hook latches, so this asserts the wiring calls both
    // rather than that either is skipped.
    expect(delivered).toContain("anchor");
    expect(delivered).toContain("ensure");
  });

  it("still delivers the record when the turn dies during setup", async () => {
    // The card is the only durable evidence a destructive reset happened, so a
    // turn that never reaches the user row must not swallow it.
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
    // Exit with no result → the adapter retries once inside the same dispatch.
    agents[0]?.emit("done", 0);
    await flushTurn();

    expect(agents.length).toBeGreaterThan(1); // the retry did happen
    expect(calls).toHaveLength(1);
  });

  it("skips a `postTurn: \"none\"` turn — a step inside the driver's own git operation", async () => {
    // docs/146's rebase-conflict resolution turn. No reset could fire (the gate
    // refuses a conflicted tree), but the planning#297 skip machinery would still
    // persist "this branch still sits on the already-merged commits" and tell
    // the agent to consider `shipit branch reset-to-base` — while its actual job
    // is to edit the conflicted files and let the driver `rebase --continue`.
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

/**
 * docs/221 / nikzlabs/shipit#2349 — the parked "your working tree was rewritten"
 * notice reaches a DISPATCHED turn too.
 *
 * docs/221 consumed it in `agent-execution.ts` alone and described it as drained
 * by "the next interactive turn". A message sent while a sync is still settling
 * is queued (the flow holds `systemTurnInProgress` through its own teardown) and
 * `releaseQueuedTurn` releases every queued entry, interactive ones included,
 * onto `runner.dispatch` — so the turn most likely to need the notice was the
 * one that could never get it. Found because the #2349 LFS restore widened that
 * window enough to make the drop deterministic in an integration test.
 */
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
      remaining = undefined; // read-and-clear, like the real transactional consume
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
    // That turn is a step INSIDE the git operation that produced the notice.
    // Handing it "your branch was rebased" would both misdirect it and burn the
    // notice the user's next real turn is owed.
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
