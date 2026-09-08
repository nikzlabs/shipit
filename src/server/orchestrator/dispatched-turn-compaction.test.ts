/**
 * docs/295 req 13 — a continuation the user did NOT type compacts too, under the
 * same setting and in the same conditions in which its branch is reset.
 *
 * planning#333 is why this is tested on day one: docs/218 scoped its branch reset
 * to the interactive path, and every programmatic continue — an Agent Interface
 * SDK click, `shipit session message`, a notify-on-merge wake — then ran on a
 * branch sitting on already-merged commits.
 *
 * These drive the REAL `SessionRunner.dispatch` → `runDispatchedTurn` path with
 * only the DECISION stubbed, so what is under test is the takeover itself: the
 * message goes back on the queue, a `/compact` turn runs, and the queue drains
 * into the message with everything it arrived carrying.
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
import { TURN_COMPLETED } from "./turn-settlement.js";

const MERGE_PREFIX = "[System] Your previous pull request (#482) was merged into main.";

function makeRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

describe("dispatched turn — the docs/295 compaction takeover (req 13)", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  /** Wire the deps with the decision answering `yes`, and record the prompts. */
  function setup(over: { decide?: boolean; resetPrefix?: string } = {}) {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const prompts: string[] = [];
    const compactFlags: (boolean | undefined)[] = [];
    const decisions: { sessionId: string; intent: boolean | undefined }[] = [];

    deps.shouldCompactBeforeTurn = async (_runner, _agentId, sessionId, _dir, intent) => {
      decisions.push({ sessionId, intent });
      // The real decision's FIRST line, and the stub is worthless without it:
      // `intent === false` is how the re-queued message says the compaction for
      // it already happened. A stub that ignored it would answer "compact" for
      // the drained message too, and could not fail on the loop that causes.
      if (intent === false) return false;
      return over.decide ?? true;
    };
    deps.preTurnReset = async (): Promise<PreTurnResetHookResult> => ({
      agentPrefix: over.resetPrefix ?? MERGE_PREFIX,
    });
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt, _route, opts) => {
      prompts.push(prompt);
      compactFlags.push(opts?.compact);
      return { prompt, cwd: "/tmp/s1" } as never;
    });
    return { agents, deps, prompts, compactFlags, decisions };
  }

  it("queues the message, runs a compaction turn, then runs the message", async () => {
    const { agents, deps, prompts, compactFlags } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({
      text: "Retry the failed import",
      agentInterface: { source: "agent_interface_sdk", surface: "preview" },
    }));
    await flushTurn();

    // The compaction turn ran first, and carries none of the user's text.
    expect(prompts[0]?.startsWith("/compact ")).toBe(true);
    expect(prompts[0]).toContain("merged");
    expect(prompts[0]).not.toContain("Retry the failed import");
    expect(compactFlags[0]).toBe(true);
    // …and it is not treated as a continuation: no branch reset, no merge
    // prefix, which would derail the summary it was asked for.
    expect(prompts[0]).not.toContain(MERGE_PREFIX);

    // It ends → the queue drains into the message the user's click sent.
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();

    expect(prompts[1]).toContain("Retry the failed import");
    expect(compactFlags[1]).toBeFalsy();
    // req 7 — and the merge prefix rides THAT turn, built after the summary was
    // written, so it cannot have been summarized away.
    expect(prompts[1]?.startsWith(MERGE_PREFIX)).toBe(true);
  });

  it("compacts exactly once — the drained message does not decide again", async () => {
    // The session is still merged and still eligible when the message drains, so
    // nothing about the SESSION stops a second decision. `compactContext: false`
    // on the re-queued entry is what does, and it says something true: the
    // compaction for this message has already happened.
    const { agents, deps, decisions, prompts } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();

    // The decision IS asked again when the entry drains — and is told the truth
    // that stops the loop. Pinning both calls rather than the count says which
    // mechanism does the stopping.
    expect(decisions).toEqual([
      { sessionId: "s1", intent: undefined },
      { sessionId: "s1", intent: false },
    ]);
    expect(prompts.filter((p) => p.startsWith("/compact "))).toHaveLength(1);
  });

  it("carries no per-send intent on this path (req 13)", async () => {
    // There is no tick box on a dispatch, so the decision must be told nothing
    // and fall through to the global setting — the rule the reset follows.
    const { deps, decisions } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    expect(decisions).toEqual([{ sessionId: "s1", intent: undefined }]);
  });

  it("settles the caller's handle from the DRAINED turn, not the compaction", async () => {
    // The compaction is ShipIt's, not the caller's. A wake turn awaiting its
    // settlement must hear about its own turn — settling on the compaction would
    // report work delivered that has not run.
    const { agents, deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    const outcomes: unknown[] = [];
    runner.dispatch(testDispatch({
      text: "wake up",
      systemTurn: true,
      deliveryId: "watch-1:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await flushTurn();

    // The compaction turn finished; the caller has heard nothing.
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[0]?.emit("done", 0);
    await flushTurn();
    expect(outcomes).toEqual([]);

    // The drained wake turn finishes → now it settles.
    agents[1]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[1]?.emit("done", 0);
    await flushTurn();
    expect(outcomes).toEqual([TURN_COMPLETED]);
  });

  it("never compacts a `postTurn: \"none\"` turn", async () => {
    // docs/146's rebase-conflict resolution turn is a step inside a git
    // operation the driver owns, not a continuation of the session's work.
    // Compacting there would summarize away the conflict context the agent is
    // holding precisely to finish the rebase.
    const { deps, decisions } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "resolve the conflicts", postTurn: "none", systemTurn: true }));
    await flushTurn();
    expect(decisions).toEqual([]);
  });

  it("never compacts a queued `/compact` the user typed (req 12)", async () => {
    // The send handler classifies an immediate `/compact`, but one that queued —
    // behind a merge hold, or behind another turn — drains through here.
    const { deps, decisions, prompts } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "/compact", execution: "interactive" }));
    await flushTurn();
    expect(decisions).toEqual([]);
    expect(prompts).toEqual(["/compact"]);
  });

  it("runs the message untouched when the decision says no", async () => {
    const { deps, prompts } = setup({ decide: false });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("keep going");
  });

  it("is a no-op when the runtime wires no decision (minimal setups)", async () => {
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
