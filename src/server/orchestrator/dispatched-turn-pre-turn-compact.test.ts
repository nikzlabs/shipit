/**
 * docs/295 req 13 — a continuation the user did NOT type compacts too, under the
 * same setting and in the same conditions in which its branch is reset.
 *
 * The sibling file (`dispatched-turn-pre-turn-reset.test.ts`) makes the same
 * argument for the branch reset, and planning#333 is why both exist: docs/218
 * scoped its reset to the interactive path, and every programmatic continue —
 * an Agent Interface SDK click, `shipit session message`, a notify-on-merge wake
 * — then ran on a branch sitting on already-merged commits. Requirement 13 puts
 * this feature in that position on day one, so the wiring is tested on day one.
 *
 * These drive the REAL `SessionRunner.dispatch` → `runDispatchedTurn` path with
 * both hooks stubbed, so what is under test is the wiring: called once per
 * message, in the right ORDER relative to the reset, never on the one excluded
 * turn shape, and with the merge prefix still reaching the prompt afterwards.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import type { PreTurnResetHookResult } from "./pre-turn-reset-hook.js";
import type { PreTurnCompactHookResult } from "./pre-turn-compact-hook.js";
import type { DependencyGap } from "./dependency-staleness.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  makeFakeAgent,
  flushTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";

const MERGE_PREFIX = "[System] Your previous pull request (#482) was merged into main.";

function makeRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

/**
 * Both hooks, stubbed onto ONE shared `order` log. The ordering assertions are
 * the point: the compaction has to run while the branch is still at the merged
 * commit, because that is what the eligibility predicate reads.
 */
function makeHooks(over: { compact?: Partial<PreTurnCompactHookResult> } = {}): {
  order: string[];
  compactCalls: { sessionId: string; sessionDir: string; intent: boolean | undefined }[];
  resetCalls: number;
  delivered: string[];
  install: (deps: ReturnType<typeof makeDispatchTurnDeps>["deps"]) => void;
} {
  const order: string[] = [];
  const compactCalls: { sessionId: string; sessionDir: string; intent: boolean | undefined }[] = [];
  const delivered: string[] = [];
  let resetCalls = 0;

  const compactResult: PreTurnCompactHookResult = {
    outcome: { kind: "compacted" },
    ...over.compact,
  };

  return {
    order,
    compactCalls,
    get resetCalls() { return resetCalls; },
    delivered,
    install: (deps) => {
      deps.preTurnCompact = async (_runner, _agentId, sessionId, sessionDir, _createAgent, intent) => {
        order.push("compact");
        compactCalls.push({ sessionId, sessionDir, intent });
        return compactResult;
      };
      deps.preTurnReset = async (): Promise<PreTurnResetHookResult> => {
        order.push("reset");
        resetCalls += 1;
        return {
          agentPrefix: MERGE_PREFIX,
          afterUserMessagePersisted: () => { delivered.push("reset:anchor"); },
        };
      };
    },
  };
}

describe("dispatched turn — pre-turn context compaction (docs/295 req 13)", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  it("compacts a programmatic continuation, with no per-send intent", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const hooks = makeHooks();
    hooks.install(deps);

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({
      text: "Retry the failed import",
      agentInterface: { source: "agent_interface_sdk", surface: "preview" },
    }));
    await flushTurn();

    // There is no tick box on this path, so the hook must be told nothing and
    // fall through to the global setting — the same rule the reset follows.
    expect(hooks.compactCalls).toEqual([
      { sessionId: "s1", sessionDir: "/tmp/s1", intent: undefined },
    ]);
  });

  it("compacts BEFORE the branch reset", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const hooks = makeHooks();
    hooks.install(deps);

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();

    // Not cosmetic. The compaction gates on `isResetEligible`, which the reset
    // makes false by moving HEAD to the base — so a compaction sequenced after
    // it could only ever be gated on the reset's own outcome, and req 6 forbids
    // that (unticking one control must not disable the other).
    expect(hooks.order).toEqual(["compact", "reset"]);
  });

  it("still carries the merge prefix into the prompt afterwards (req 7)", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const hooks = makeHooks();
    hooks.install(deps);
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "next slice" }));
    await flushTurn();

    // The guarantee docs/218 gives must not become weaker. The prefix is built
    // after the compaction and handed only to THIS turn's run params, so it
    // cannot have been absorbed into the summary — which matters most on Codex
    // and OpenCode, where the compaction instructions are ignored outright.
    expect(promptSeen.startsWith(MERGE_PREFIX)).toBe(true);
    expect(promptSeen).toContain("next slice");
  });

  it("compacts once per dispatched message, not once per no-result retry", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const hooks = makeHooks();
    hooks.install(deps);

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    // Exit with no result → the adapter retries once inside the same dispatch.
    agents[0]?.emit("done", 0);
    await flushTurn();

    expect(agents.length).toBeGreaterThan(1); // the retry did happen
    // A second compaction would summarize away the context the retry needs, and
    // cost the user another wait for a turn they never sent twice.
    expect(hooks.compactCalls).toHaveLength(1);
  });

  it("never compacts a `postTurn: \"none\"` turn", async () => {
    // docs/146's rebase-conflict resolution turn: a step inside a git operation
    // the driver owns, not a continuation of the session's work. Compacting
    // there would summarize away the conflict context the agent is holding
    // precisely to finish the rebase.
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const hooks = makeHooks();
    hooks.install(deps);

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "resolve the conflicts", postTurn: "none", systemTurn: true }));
    await flushTurn();

    expect(hooks.compactCalls).toHaveLength(0);
    expect(hooks.order).toEqual([]);
  });

  it("delivers a compaction failure notice, and still runs the turn (req 9)", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const delivered: string[] = [];
    const hooks = makeHooks({
      compact: {
        outcome: { kind: "failed", detail: "the CLI exited with code 1" },
        afterUserMessagePersisted: () => { delivered.push("compact:anchor"); },
        ensureRecorded: () => { delivered.push("compact:ensure"); },
      },
    });
    hooks.install(deps);
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "next slice" }));
    await flushTurn();

    // The turn is never lost because the compaction did not complete.
    expect(promptSeen).toContain("next slice");
    // Both triggers fire; the real hook latches so exactly one writes.
    expect(delivered).toContain("compact:anchor");
    expect(delivered).toContain("compact:ensure");
  });

  it("delivers BOTH hooks' records when the turn dies before the anchor", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const delivered: string[] = [];
    const hooks = makeHooks({
      compact: {
        outcome: { kind: "no-compaction" },
        afterUserMessagePersisted: () => { delivered.push("compact:anchor"); },
        ensureRecorded: () => { delivered.push("compact:ensure"); },
      },
    });
    hooks.install(deps);
    deps.agentFactory = () => { throw new Error("container unreachable"); };

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    const outcome = await runner.dispatch(testDispatch({ text: "keep going" })).settled;

    expect(outcome.status).toBe("errored");
    // The turn never reached the user row, so only the `finally` route runs.
    expect(delivered).toEqual(["compact:ensure"]);
  });

  it("runs neither hook for a queued `/compact`, and spawns it as a compaction (req 12)", async () => {
    // The send handler classifies an IMMEDIATE `/compact`, but one that had to
    // queue — behind a merge hold, or behind a dispatched turn — drains through
    // this path. Unclassified here it reset the branch, added a second
    // compaction, and then handed the CLI the literal command behind a
    // `[System] …PR was merged…` prefix without the adapter's compaction flag,
    // so the in-band recognition never happened either.
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const hooks = makeHooks();
    hooks.install(deps);
    let promptSeen = "";
    let compactFlag: boolean | undefined;
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt, _route, rpOpts) => {
      promptSeen = prompt;
      compactFlag = rpOpts?.compact;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "/compact", execution: "interactive" }));
    await flushTurn();

    expect(hooks.order).toEqual([]);
    // No merge prefix in front of it — that is what defeats in-band parsing.
    expect(promptSeen).toBe("/compact");
    expect(compactFlag).toBe(true);
  });

  it("still recognizes `/compact <instructions>`", async () => {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const hooks = makeHooks();
    hooks.install(deps);

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "/compact keep the open questions" }));
    await flushTurn();

    expect(hooks.order).toEqual([]);
  });

  it("does NOT treat an ordinary message mentioning compact as the command", async () => {
    // The other half of the guard: a skip that fires too eagerly would silently
    // stop resetting merged branches.
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const hooks = makeHooks();
    hooks.install(deps);

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "please /compact the docs folder later" }));
    await flushTurn();

    expect(hooks.order).toEqual(["compact", "reset"]);
  });

  it("keeps the dependency-gap prefix off a `/compact` too (req 12)", async () => {
    // The last of the four prefixes, and the one that was still prepended
    // unconditionally: a `[System] …run the install…` in front of the command
    // defeats the in-band recognition Grok does on the prompt, so the user's one
    // compaction is spent as prose. Nothing is lost — the prefix is re-derived
    // from live runner state, so the next real turn carries it unchanged.
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    makeHooks().install(deps);
    let promptSeen = "";
    deps.buildRunParams = vi.fn(async (_sid, _agentId, prompt) => {
      promptSeen = prompt;
      return { prompt, cwd: "/tmp/s1" } as never;
    });

    runner = makeRunner();
    (runner as unknown as { dependencyGap: DependencyGap }).dependencyGap = {
      reason: "install-failed",
      commands: ["npm ci"],
    };
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "/compact" }));
    await flushTurn();

    expect(promptSeen).toBe("/compact");
  });

  it("holds the session against admission across BOTH hooks", async () => {
    // The hold used to be taken inside the compaction hook and released when it
    // returned — so the branch reset, the DESTRUCTIVE half, ran with the session
    // reading admissible again.
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const held: boolean[] = [];

    runner = makeRunner();
    deps.preTurnCompact = async () => {
      held.push(runner.preTurnHold);
      return { outcome: { kind: "compacted" } };
    };
    deps.preTurnReset = async (): Promise<PreTurnResetHookResult> => {
      held.push(runner.preTurnHold);
      return { agentPrefix: "" };
    };
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();

    expect(held).toEqual([true, true]);
    // …and gives it back, or every later message in the session queues forever.
    expect(runner.preTurnHold).toBe(false);
  });

  it("queues a message that arrives mid-phase instead of steering it into a doomed process", async () => {
    // The reachable window, and it opens BEFORE the compaction spawns: the merge
    // probe is a network round-trip and the eligibility check reads git, and for
    // both of those the resident streaming process is still installed and still
    // steerable. A message steered in there is injected into the exact process
    // the compaction is about to retire and kill — delivered nowhere, with no
    // error. `running` cannot catch this: `running` is what makes the arrival
    // take the steer branch in the first place.
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    let releaseCompaction = (): void => {};
    const compacting = new Promise<void>((r) => { releaseCompaction = r; });

    runner = makeRunner();
    // The pre-retire shape: a live streaming CLI in the slot.
    const resident = makeFakeAgent();
    runner.setAgent(resident as never);
    runner.isStreamingActive = true;
    deps.preTurnCompact = async () => {
      await compacting;
      return { outcome: { kind: "compacted" } };
    };
    deps.preTurnReset = async (): Promise<PreTurnResetHookResult> => ({ agentPrefix: "" });
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "first" }));
    await flushTurn();

    runner.dispatch(testDispatch({ text: "second" }));
    expect(resident.sendUserMessage).not.toHaveBeenCalled();
    expect(runner.queueLength).toBe(1);

    releaseCompaction();
    await flushTurn();
  });

  it("does not let a FINISHED turn's drain start a turn beside a pre-turn phase", async () => {
    // The interleaving no other guard covers, and the one the epoch check cannot
    // catch: turn A ends and its drain runs from the gap while its local commit
    // is awaited; message B has already been admitted and is inside its pre-turn
    // phase; B has not bumped the turn epoch (that happens in
    // `executeAgentTurn`), so A's drain happily starts C alongside it — two
    // turns, one working tree, one agent slot.
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    makeHooks().install(deps);

    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "A" }));
    await flushTurn();

    // C queues behind the running turn A, and B's pre-turn phase takes the hold.
    // (Which send holds it does not matter to the guard — that a phase is in
    // flight does.)
    runner.dispatch(testDispatch({ text: "C" }));
    expect(runner.queueLength).toBe(1);
    runner.preTurnHold = true;

    // A finishes: its terminal path runs `drainNext`.
    const spawnsBefore = agents.length;
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "a1" });
    await flushTurn();

    expect(agents).toHaveLength(spawnsBefore); // C did NOT start
    expect(runner.queueLength).toBe(1);        // …and was not lost either
    runner.preTurnHold = false;
  });

  it("publishes the delivery for the pre-turn phase of a DRAINED turn", async () => {
    // planning#266 — `dispatchOnRunner` publishes ownership for a turn it starts
    // from idle; a drain calls `runDispatchedTurn` straight. So the compaction —
    // which can wait minutes on a CLI — ran with the delivery reading as
    // not-in-flight, and a redelivery supervisor sent the identical prompt again.
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const seen: { delivery: string | undefined; running: boolean }[] = [];

    runner = makeRunner();
    deps.preTurnCompact = async () => {
      seen.push({ delivery: runner.activeDeliveryId, running: runner.running });
      return { outcome: { kind: "compacted" } };
    };
    deps.preTurnReset = async (): Promise<PreTurnResetHookResult> => ({ agentPrefix: "" });
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "first", deliveryId: "d-1" }));
    await flushTurn();
    // Queued behind the running turn, then drained by its own terminal path.
    runner.dispatch(testDispatch({ text: "second", deliveryId: "d-2" }));
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "a1" });
    await flushTurn();

    expect(seen).toEqual([
      { delivery: "d-1", running: true },
      { delivery: "d-2", running: true },
    ]);
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
