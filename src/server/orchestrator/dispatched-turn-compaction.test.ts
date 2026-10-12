import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "./session-runner.js";
import type { AgentId } from "../shared/types.js";
import type { PreTurnResetHookResult } from "./pre-turn-reset-hook.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  flushTurn,
  waitForTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";
import { TURN_COMPLETED } from "./turn-settlement.js";
import type { QueuedMessage } from "./session-runner.js";
import { takeSessionHold } from "./session-hold.js";
import { MISSED_COMPACTION_NOTICE } from "./compact-before-turn.js";

const MERGE_PREFIX = "[System] Your previous pull request (#482) was merged into main.";

function makeRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

describe("dispatched turn — the docs/295 compaction takeover (req 13)", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  function setup(over: { decide?: boolean; resetPrefix?: string } = {}) {
    const agents: FakeAgent[] = [];
    const appended: { role?: string; text?: string }[] = [];
    const { deps } = makeDispatchTurnDeps(agents, appended);
    const prompts: string[] = [];
    const compactFlags: (boolean | undefined)[] = [];
    const decisions: { sessionId: string; intent: boolean | undefined }[] = [];

    deps.shouldCompactBeforeTurn = async (_runner, _agentId, sessionId, _dir, intent) => {
      decisions.push({ sessionId, intent });
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

    expect(prompts[0]?.startsWith("/compact ")).toBe(true);
    expect(prompts[0]).toContain("merged");
    expect(prompts[0]).not.toContain("Retry the failed import");
    expect(compactFlags[0]).toBe(true);
    expect(prompts[0]).not.toContain(MERGE_PREFIX);

    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();

    expect(prompts[1]).toContain("Retry the failed import");
    expect(compactFlags[1]).toBeFalsy();
    expect(prompts[1]?.startsWith(MERGE_PREFIX)).toBe(true);

    const userRows = appended.filter((m) => m.role === "user");
    expect(userRows.map((m) => m.text)).toEqual(["Retry the failed import"]);
  });

  // docs/329-user-steers-every-turn — a turn of the CLI's own could come between the two.
  it("does not compact ahead of a turn while the resident process has background work", async () => {
    const { agents, deps, prompts, decisions } = setup();
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "first", compactContext: false }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "s" });
    await flushTurn();
    runner.setBackgroundTasks([{ id: "t1", description: "npm test" }]);
    expect(runner.backgroundWorkDescriptions).toEqual(["npm test"]);
    decisions.length = 0;

    runner.dispatch(testDispatch({ text: "Your PR #7 merged.", automatic: true }));
    await flushTurn();

    expect(decisions).toEqual([]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Your PR #7 merged."));
    expect(prompts.some((p) => p.startsWith("/compact"))).toBe(false);
  });

  it("tells the decision when nobody was at the composer (req 15)", async () => {
    const cases: [Parameters<typeof testDispatch>[0], boolean][] = [
      [{ text: "a page message", agentInterface: { source: "agent_interface_sdk", surface: "present" } }, false],
      [{ text: "a card button" }, false],
      // docs/328's turn for a message the user sent: not automatic.
      [{ text: "a wake", unattended: true }, true],
      [{ text: "a CI fix", automatic: true, ciAutoFix: true }, true],
      [{ text: "a preview fix", automatic: true }, true],
      // A parent's first prompt to a new child: no merged pull request, so the answer is not used.
      [{
        text: "from another session",
        messageOrigin: { sessionId: "p", sessionTitle: "Parent", relation: "parent" },
      }, false],
    ];
    const seen: boolean[] = [];
    for (const [dispatch] of cases) {
      const { deps } = setup();
      deps.shouldCompactBeforeTurn = async (_runner, _agentId, _sessionId, _dir, _intent, unattended) => {
        seen.push(unattended === true);
        return false;
      };
      runner = makeRunner();
      runner.setSystemTurnDeps(deps);
      runner.dispatch(testDispatch(dispatch));
      await flushTurn();
      runner.dispose({ force: true });
    }
    expect(seen).toEqual(cases.map(([, unattended]) => unattended));
  });

  it("keeps the message NEXT — an entry already queued does not overtake it", async () => {
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

  // docs/329-user-steers-every-turn — the claim on `running` keeps others out; no flag does.
  it("keeps the runner claimed while the decision runs, so a send meanwhile queues", async () => {
    let resolveDecision: ((v: boolean) => void) | undefined;
    const { agents, deps } = setup();
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    deps.shouldCompactBeforeTurn = () => new Promise<boolean>((r) => { resolveDecision = r; });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    expect(runner.running).toBe(true);

    expect(runner.dispatch(testDispatch({ text: "and this" })).admitted).toBe("queued");
    resolveDecision?.(false);
    await flushTurn();
    expect(agents).toHaveLength(1);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["and this"]);
  });

  it("takes no message into the compaction turn: a send meanwhile queues behind it", async () => {
    const { agents, deps, prompts } = setup();
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    expect(prompts[0]?.startsWith("/compact ")).toBe(true);

    expect(runner.dispatch(testDispatch({ text: "and this" })).admitted).toBe("queued");
    expect(agents[0]!.sendUserMessage).not.toHaveBeenCalled();
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["keep going", "and this"]);
  });

  it("writes the missed-compaction notice also when a flow takes the session during the commit", async () => {
    const { agents, deps, appended } = setup();
    deps.autoCommit = vi.fn(async () => {
      takeSessionHold(runner);
      return { commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [] };
    }) as never;
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();

    expect(appended.some((m) => m.text === MISSED_COMPACTION_NOTICE)).toBe(true);
    // The flow releases the queue; the turn's drain does not start the message under its hold.
    expect(agents).toHaveLength(1);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["keep going"]);
  });

  it("keeps the runner reserved while the drained wake sets up after the compaction", async () => {
    const { agents, deps } = setup();
    let releaseReset: (() => void) | undefined;
    deps.preTurnReset = () => new Promise((r) => { releaseReset = () => r({ agentPrefix: MERGE_PREFIX }); });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "wake up", automatic: true, deliveryId: "watch-3:1" }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();
    expect(releaseReset).toBeDefined();
    expect(runner.running).toBe(true);
    expect(runner.activeDeliveryId).toBe("watch-3:1");
    releaseReset?.();
    await flushTurn();
    expect(agents).toHaveLength(2);
  });

  it("checks for the compaction card once, also when the CLI starts a turn of its own after it", async () => {
    const { agents, deps, appended } = setup({ decide: false });
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "/compact", silent: true, automatic: true }));
    await flushTurn();
    const agent = agents[0]!;
    agent.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();

    // A background job ends: the CLI starts a turn on the same process, which drains again.
    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    await flushTurn();
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();
    await flushTurn();

    expect(appended.filter((m) => m.text === MISSED_COMPACTION_NOTICE)).toHaveLength(0);
  });

  it("checks the record of cards when the CLI starts a turn before the compaction's own drain", async () => {
    const { agents, deps, appended } = setup({ decide: false });
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    const cards: { id: string }[] = [];
    Object.assign(deps.listenerDeps.chatHistoryManager, {
      replaceInProgress: (_sid: string, rows: { compaction?: { id: string } }[]) => {
        for (const row of rows) {
          if (row.compaction && !cards.some((c) => c.id === row.compaction!.id)) cards.push(row.compaction);
        }
      },
      latestCompactionCard: () => cards.at(-1),
    });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "/compact", silent: true, automatic: true }));
    await flushTurn();
    const agent = agents[0]!;
    agent.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    await flushTurn();
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await waitForTurn(() => !runner.running && !runner.postTurnWorkInFlight, "both turns ended");

    expect(cards).toHaveLength(1);
    expect(appended.filter((m) => m.text === MISSED_COMPACTION_NOTICE)).toHaveLength(0);
  });

  it("does not let the one-shot compaction's late `done` end the wake that it drained", async () => {
    const { agents, deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "wake up", automatic: true, deliveryId: "watch-4:1" }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[0]?.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(agents).toHaveLength(2);
    expect(runner.running).toBe(true);
    agents[1]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[1]?.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.running).toBe(false);
  });

  it("does not let the compaction's result count for an ID-less dispatch either", async () => {
    const { agents, deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    const outcomes: { status: string }[] = [];
    runner.dispatch(testDispatch({ text: "fix the build", onTurnComplete: (o) => outcomes.push(o) }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[0]?.emit("done", 0);
    await flushTurn();
    runner.dispose({ force: true });
    await flushTurn();
    expect(outcomes.map((o) => o.status)).toEqual(["dropped"]);
  });

  it("does not let the compaction's result count as the wake's result", async () => {
    const { agents, deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    const outcomes: { status: string }[] = [];
    runner.dispatch(testDispatch({
      text: "wake up",
      automatic: true,
      deliveryId: "watch-2:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[0]?.emit("done", 0);
    await flushTurn();
    runner.dispose({ force: true });
    await flushTurn();
    expect(outcomes.map((o) => o.status)).toEqual(["dropped"]);
  });

  it("compacts exactly once — the drained message does not decide again", async () => {
    const { agents, deps, decisions, prompts } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();

    expect(decisions).toEqual([
      { sessionId: "s1", intent: undefined },
      { sessionId: "s1", intent: false },
    ]);
    expect(prompts.filter((p) => p.startsWith("/compact "))).toHaveLength(1);
  });

  it("carries no per-send intent on this path (req 13)", async () => {
    const { deps, decisions } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    expect(decisions).toEqual([{ sessionId: "s1", intent: undefined }]);
  });

  it("settles the caller's handle from the DRAINED turn, not the compaction", async () => {
    const { agents, deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    const outcomes: unknown[] = [];
    runner.dispatch(testDispatch({
      text: "wake up",
      automatic: true,
      deliveryId: "watch-1:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await flushTurn();

    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[0]?.emit("done", 0);
    await flushTurn();
    expect(outcomes).toEqual([]);

    agents[1]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[1]?.emit("done", 0);
    await flushTurn();
    expect(outcomes).toEqual([TURN_COMPLETED]);
  });

  it("never compacts a `postTurn: \"none\"` turn", async () => {
    const { deps, decisions } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "resolve the conflicts", postTurn: "none" }));
    await flushTurn();
    expect(decisions).toEqual([]);
  });

  it("never compacts a queued `/compact` the user typed (req 12)", async () => {
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
