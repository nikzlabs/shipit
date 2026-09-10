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

  it("holds the system-turn flag while the decision runs, and releases it on `no`", async () => {
    let resolveDecision: ((v: boolean) => void) | undefined;
    const { deps } = setup();
    deps.shouldCompactBeforeTurn = () => new Promise<boolean>((r) => { resolveDecision = r; });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    expect(runner.systemTurnInProgress).toBe(true);
    resolveDecision?.(false);
    await flushTurn();
    expect(runner.systemTurnInProgress).toBe(false);
  });

  it("runs the compaction as ShipIt's own turn, so a send meanwhile queues behind it", async () => {
    const { deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going", systemTurn: undefined }));
    await flushTurn();
    expect(runner.running).toBe(true);
    expect(runner.systemTurnInProgress).toBe(true);
  });

  it("keeps the runner reserved while the drained wake sets up after the compaction", async () => {
    const { agents, deps } = setup();
    let releaseReset: (() => void) | undefined;
    deps.preTurnReset = () => new Promise((r) => { releaseReset = () => r({ agentPrefix: MERGE_PREFIX }); });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "wake up", systemTurn: true, deliveryId: "watch-3:1" }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    await flushTurn();
    expect(releaseReset).toBeDefined();
    expect(runner.running).toBe(true);
    expect(runner.systemTurnInProgress).toBe(true);
    expect(runner.activeDeliveryId).toBe("watch-3:1");
    releaseReset?.();
    await flushTurn();
    expect(agents).toHaveLength(2);
  });

  it("does not let the one-shot compaction's late `done` clear the wake's system-turn flag", async () => {
    const { agents, deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "wake up", systemTurn: true, deliveryId: "watch-4:1" }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[0]?.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(agents).toHaveLength(2);
    expect(runner.systemTurnInProgress).toBe(true);
    agents[1]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[1]?.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.systemTurnInProgress).toBe(false);
  });

  it("lowers the flag for a non-system continuation even when the compaction's `done` is late", async () => {
    const { agents, deps } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.dispatch(testDispatch({ text: "keep going" }));
    await flushTurn();
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[0]?.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(agents).toHaveLength(2);
    expect(runner.systemTurnInProgress).toBe(false);
  });

  it("a non-system entry drained behind ANY system turn lowers the flag itself", async () => {
    const { agents, deps } = setup({ decide: false });
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    runner.enqueue({ text: "B, a user's message", execution: "dispatched" } as QueuedMessage);
    runner.dispatch(testDispatch({ text: "a CI fix", systemTurn: true }));
    await flushTurn();
    expect(runner.systemTurnInProgress).toBe(true);
    agents[0]?.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    agents[0]?.emit("done", 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(agents).toHaveLength(2);
    expect(runner.systemTurnInProgress).toBe(false);
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
      systemTurn: true,
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
      systemTurn: true,
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
    runner.dispatch(testDispatch({ text: "resolve the conflicts", postTurn: "none", systemTurn: true }));
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
