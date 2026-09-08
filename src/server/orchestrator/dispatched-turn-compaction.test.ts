/**
 * docs/295 req 13 — a continuation the user did NOT type compacts too (an Agent
 * Interface SDK click, `shipit session message`, a notify-on-merge wake), in the
 * same conditions in which its branch is reset (planning#333).
 *
 * These drive the REAL `SessionRunner.dispatch` → `runDispatchedTurn` path with
 * only the decision stubbed.
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
import type { QueuedMessage } from "./session-runner.js";

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
    const appended: { role?: string; text?: string }[] = [];
    const { deps } = makeDispatchTurnDeps(agents, appended);
    const prompts: string[] = [];
    const compactFlags: (boolean | undefined)[] = [];
    const decisions: { sessionId: string; intent: boolean | undefined }[] = [];

    deps.shouldCompactBeforeTurn = async (_runner, _agentId, sessionId, _dir, intent) => {
      decisions.push({ sessionId, intent });
      // The real decision's first gate; without it the stub could not fail on
      // the compact-forever loop the re-queued `intent: false` prevents.
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
    return { agents, deps, prompts, compactFlags, decisions, appended };
  }

  it("queues the message, runs a compaction turn, then runs the message", async () => {
    const { agents, deps, prompts, compactFlags, appended } = setup();
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

    // Exactly one user row: the compaction turn is `silent`, nobody typed it.
    const userRows = appended.filter((m) => m.role === "user");
    expect(userRows.map((m) => m.text)).toEqual(["Retry the failed import"]);
  });

  it("keeps the message NEXT — an entry already queued does not overtake it", async () => {
    // The queue held B; A was dispatched and taken over. A goes to the FRONT,
    // so after the compaction A runs, then B — the order they arrived in.
    const { agents, deps, prompts, decisions } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.enqueue({ text: "B, queued earlier", execution: "dispatched" } as QueuedMessage);

    runner.dispatch(testDispatch({ text: "A, dispatched now" }));
    await flushTurn();
    expect(runner.getQueueSnapshot().map((q) => q.text)).toEqual(["A, dispatched now", "B, queued earlier"]);

    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();
    expect(prompts[1]).toContain("A, dispatched now");
    expect(decisions.at(-1)).toEqual({ sessionId: "s1", intent: false });
  });

  it("runs the compaction as ShipIt's own turn, so a send meanwhile queues behind it", async () => {
    // An SDK click is not a system turn; the compaction ahead of it is.
    const { deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going", systemTurn: undefined }));
    await flushTurn();
    expect(runner.running).toBe(true);
    expect(runner.systemTurnInProgress).toBe(true);
  });

  it("does not let the compaction's result count as the wake's result", async () => {
    // The wake's dispatch latches `turn_result` to tell `interrupted` (ran, then
    // cut short — do not redeliver) from `dropped` (never ran — redeliver). The
    // compaction's result must not latch it: a runner disposed after the
    // compaction but before the wake ran would report the wake delivered.
    const { agents, deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    const outcomes: { status: string }[] = [];
    runner.dispatch(testDispatch({
      text: "wake up",
      systemTurn: true,
      deliveryId: "watch-2:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[0]?.emit("done", 0);
    await flushTurn();
    // The wake has been dequeued and is starting; dispose now.
    runner.dispose({ force: true });
    await flushTurn();
    expect(outcomes.map((o) => o.status)).toEqual(["dropped"]);
  });

  it("compacts exactly once — the drained message does not decide again", async () => {
    // The session is still eligible when the message drains; `compactContext:
    // false` on the re-queued entry is what stops a second compaction.
    const { agents, deps, decisions, prompts } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();

    // Asked again on the drain, and told `false`.
    expect(decisions).toEqual([
      { sessionId: "s1", intent: undefined },
      { sessionId: "s1", intent: false },
    ]);
    expect(prompts.filter((p) => p.startsWith("/compact "))).toHaveLength(1);
  });

  it("carries no per-send intent on this path (req 13)", async () => {
    // No tick box on a dispatch: the decision is told nothing.
    const { deps, decisions } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    expect(decisions).toEqual([{ sessionId: "s1", intent: undefined }]);
  });

  it("settles the caller's handle from the DRAINED turn, not the compaction", async () => {
    // A wake turn awaiting settlement must hear about its own turn.
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
    // A rebase-resolution turn (docs/146) is a step inside a git operation, and
    // compacting there would summarize away the conflict context.
    const { deps, decisions } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "resolve the conflicts", postTurn: "none", systemTurn: true }));
    await flushTurn();
    expect(decisions).toEqual([]);
  });

  it("never compacts a queued `/compact` the user typed (req 12)", async () => {
    // A `/compact` that queued behind a merge hold or another turn drains here.
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
