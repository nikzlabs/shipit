import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { SettingsProposalStore } from "../settings-proposal-store.js";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId, AgentProcess } from "../../shared/types.js";
import type { TurnOutcome } from "../turn-settlement.js";
import { ProviderRouteUnavailableError } from "../provider-route-preflight.js";
import { prepareSettingsOutcomeNotice } from "../services/settings-outcome-notice.js";
import { renderOwn } from "../../shared/settings-catalogue/index.js";
import {
  postSettingsProposal,
  transitionSettingsProposal,
} from "../services/settings-proposal.js";
import {
  makeDispatchTurnDeps,
  makeFakeAgent,
  testDispatch,
  waitForTurn,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

/**
 * Requirement 8 end to end: a resolved proposal card reaches the agent at the
 * start of its next turn, exactly once, and an outcome that never reached a turn
 * is carried rather than dropped (docs/299-agent-settings-access).
 */

const SESSION = "sess-1";
const KEY = "advanced.enableSubAgents";

let dbManager: DatabaseManager;
let sessions: SessionManager;
let chatHistoryManager: ChatHistoryManager;
let proposals: SettingsProposalStore;
let runner: SessionRunner;
let agents: FakeAgent[];
let deps: SystemTurnDeps;
let buildRunParams: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  sessions = new SessionManager(dbManager);
  sessions.track(SESSION, "A session");
  chatHistoryManager = new ChatHistoryManager(dbManager);
  proposals = new SettingsProposalStore(dbManager);
  agents = [];

  const built = makeDispatchTurnDeps(agents, []);
  deps = built.deps;
  // The shared fake returns a fixed prompt; echo the real one through, so the
  // assertions below read what `agent.run` was actually given.
  buildRunParams = vi.fn(async (_sessionId: string, _agentId: AgentId, prompt: string) => ({
    prompt,
    cwd: "/tmp/s1",
  }));
  deps.buildRunParams = buildRunParams as unknown as SystemTurnDeps["buildRunParams"];
  // The real read and the real receipt; only the agent process is a fake.
  deps.settingsOutcomeNotice = (sessionId) =>
    prepareSettingsOutcomeNotice({ proposals, chatHistoryManager }, sessionId);

  runner = new SessionRunner({
    sessionId: SESSION,
    sessionDir: "/tmp/s1",
    defaultAgentId: "claude" as AgentId,
  });
  runner.setSystemTurnDeps(deps);
  settled = [];
});

afterEach(() => {
  runner.dispose({ force: true });
  dbManager.close();
  vi.restoreAllMocks();
});

/** Post a real card, then resolve it with no runner anywhere — the user clicked long after the turn. */
function postAndResolve(
  cardId: string,
  phase: "applied" | "dismissed",
  over: { label?: string; from?: string; to?: string } = {},
): void {
  const proposalDeps = {
    chatHistoryManager,
    proposals,
    getRunnerRegistry: () => undefined,
  };
  const card = postSettingsProposal(proposalDeps, runner, {
    sessionId: SESSION,
    target: { key: KEY },
    operation: "set",
    from: renderOwn(over.from ?? "off"),
    to: renderOwn(over.to ?? "on"),
    fromValue: false,
    proposedValue: true,
    baseline: { revision: cardId },
    reason: "The review you asked for runs as a separate agent.",
  });
  transitionSettingsProposal(proposalDeps, SESSION, card.cardId, {
    phase,
    resolvedAt: new Date().toISOString(),
  });
}

/** The prompt one attempt's agent process was actually run with. */
function promptOfAttempt(index: number): string {
  const ran = agents.filter((a) => a.run.mock.calls.length > 0);
  const params = ran[index]?.run.mock.calls[0]?.[0] as { prompt?: string } | undefined;
  if (!params) throw new Error(`no agent run at index ${index}`);
  return String(params.prompt);
}

/**
 * `runner.running` goes false during the drain, before the turn settles, so a
 * test that waited on the runner would read the transcript mid-teardown.
 */
let settled: TurnOutcome[] = [];

/**
 * The agent of the attempt now running. Indices do not line up with run-params
 * calls: a failover attempt whose env preparation throws creates an agent that
 * never runs.
 */
async function completeTurn(): Promise<void> {
  const agent = [...agents].reverse().find((a) => a.run.mock.calls.length > 0);
  if (!agent) throw new Error("no agent has been run");
  const before = settled.length;
  agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
  agent.emit("done", 0);
  await waitForTurn(() => settled.length > before, "turn settled");
}

async function dispatch(text: string, expectRuns: number): Promise<void> {
  runner.dispatch(testDispatch({ text, onTurnComplete: (outcome) => { settled.push(outcome); } }));
  await waitForTurn(
    () => agents.filter((a) => a.run.mock.calls.length > 0).length === expectRuns,
    `agent run ${expectRuns}`,
  );
}

describe("a resolved settings proposal reaches the agent's next turn", () => {
  it("is delivered once and does not repeat on the turn after", async () => {
    postAndResolve("set-a", "applied");

    await dispatch("keep going", 1);
    const first = promptOfAttempt(0);
    expect(first).toContain("[ShipIt] Since your last turn, the user resolved a settings proposal");
    expect(first).toContain(KEY);
    expect(first).toContain("APPLIED");
    expect(first.endsWith("keep going")).toBe(true);
    await completeTurn();

    await dispatch("and again", 2);
    const second = promptOfAttempt(1);
    expect(second).not.toContain("[ShipIt] Since your last turn");
    expect(second).toBe("and again");
    await completeTurn();
  });

  it("notifies a card resolved when no runner was alive to hear the click", async () => {
    // postAndResolve resolves with `getRunnerRegistry` returning nothing at all,
    // which is the shape of a click hours after the turn ended.
    postAndResolve("set-a", "dismissed");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);

    await dispatch("what now?", 1);
    expect(promptOfAttempt(0)).toContain("DISMISSED");
    await completeTurn();

    expect(proposals.get(proposals.listByPhase("dismissed")[0]!.cardId)?.agentNotified).toBe(true);
  });

  /*
    req 8 says "the next turn" and names no kind of turn, so the next one ShipIt
    runs by itself — an auto CI fix, a conflict resolution, a wake — carries the
    outcome as an ordinary turn does. It used to be excluded at both call sites,
    which left the outcome waiting for a later ordinary turn that may be hours
    away and may never come.
  */
  it("rides an automatic turn ShipIt runs by itself", async () => {
    postAndResolve("set-a", "dismissed");

    runner.dispatch(testDispatch({
      text: "CI is failing. Fix it.",
      systemTurn: true,
      onTurnComplete: (outcome) => { settled.push(outcome); },
    }));
    await waitForTurn(
      () => agents.filter((a) => a.run.mock.calls.length > 0).length === 1,
      "the system turn's agent run",
    );

    const prompt = promptOfAttempt(0);
    expect(prompt).toContain("[ShipIt] Since your last turn, the user resolved a settings proposal");
    expect(prompt).toContain("DISMISSED");
    expect(prompt.endsWith("CI is failing. Fix it.")).toBe(true);

    await completeTurn();
    expect(proposals.listUnnotifiedResolved(SESSION)).toEqual([]);
  });

  /*
    A retired process can emit a result for its own prompt after a successor has
    taken the agent slot — the turn is settled `interrupted` and its work
    discarded. Acknowledging there spends the receipt on a turn whose output
    nobody reads, and the successor, which carries the same notice, has nothing
    left to settle. Reachable for an ordinary turn too; it became reachable for
    an automatic one the moment those started carrying the notice.
  */
  it("acknowledges nothing when a newer turn took the slot first", async () => {
    postAndResolve("set-a", "applied");

    runner.dispatch(testDispatch({
      text: "resolve the conflicts",
      systemTurn: true,
      postTurn: "none",
      onTurnComplete: (outcome) => { settled.push(outcome); },
    }));
    await waitForTurn(
      () => agents.filter((a) => a.run.mock.calls.length > 0).length === 1,
      "the superseded turn's agent run",
    );
    expect(promptOfAttempt(0)).toContain("[ShipIt] Since your last turn");

    // A successor takes the slot, which retires this turn's process.
    runner.setAgent(makeFakeAgent() as unknown as AgentProcess);
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => settled.length > 0, "the superseded turn settled");

    expect(settled[0]?.status).toBe("interrupted");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  it("batches several outcomes into one notice", async () => {
    postAndResolve("set-a", "applied");
    postAndResolve("set-b", "dismissed");
    postAndResolve("set-c", "applied");

    await dispatch("carry on", 1);
    const prompt = promptOfAttempt(0);
    expect(prompt.match(/^\[ShipIt] Since your last turn/gm)).toHaveLength(1);
    expect(prompt).toContain("settings proposals you posted");
    expect(prompt.match(/^- /gm)).toHaveLength(3);
    await completeTurn();

    // All three, in one acknowledgement: a notice that named a card and did not
    // acknowledge it would repeat it on every turn from here on.
    expect(proposals.listUnnotifiedResolved(SESSION)).toEqual([]);
  });
});

const QUOTA_ERROR = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";

describe("a turn the agent never saw acknowledges nothing", () => {
  /** One account, then another, then nothing — the all-refused report's own shape. */
  function twoAccountsThenNothing(): void {
    const order = ["acct-1", "acct-2"];
    (deps.prepareAgentEnv as unknown) = vi.fn(
      async (_sessionId: string, _agentId: AgentId, opts?: { excludeRouteIds?: readonly string[] }) => {
        const excluded = opts?.excludeRouteIds ?? [];
        const next = order.find((id) => !excluded.includes(id));
        if (!next) {
          throw new ProviderRouteUnavailableError("claude" as AgentId, {
            reason: "all_exhausted",
            earliestResetAt: null,
          });
        }
        return { turnRoute: { kind: "account" as const, id: next } };
      },
    );
    deps.routeLabel = (routeId: string) => ({ "acct-1": "Personal", "acct-2": "Work" })[routeId];
  }

  it("carries the outcome to a later runnable turn when every account refuses for quota", async () => {
    twoAccountsThenNothing();
    postAndResolve("set-a", "applied");

    await dispatch("unblock me", 1);
    expect(promptOfAttempt(0)).toContain("[ShipIt] Since your last turn");

    // Each failover attempt re-dispatches this same prompt, so the notice rides
    // every one of them — and none of them is the agent reading it.
    agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitForTurn(
      () => agents.filter((a) => a.run.mock.calls.length > 0).length === 2,
      "second account's attempt",
    );
    expect(promptOfAttempt(1)).toContain("[ShipIt] Since your last turn");

    agents[1]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitForTurn(() => settled.length > 0, "turn settled");

    // The turn ended in ShipIt's own all-refused text, which the agent did not
    // write and never read. Keying the rule on produced output, or on
    // `agent_result.status === "success"`, consumes the outcome right here.
    expect(runner.lastTurnErrored).toBe(true);
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);

    // A later turn on a working account still receives it. The third attempt
    // threw during env preparation, so it never ran and is not counted here.
    (deps.prepareAgentEnv as unknown) = vi.fn().mockResolvedValue(undefined);
    await dispatch("try again", 3);
    expect(promptOfAttempt(2)).toContain("[ShipIt] Since your last turn");
    expect(promptOfAttempt(2)).toContain("APPLIED");
    await completeTurn();

    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(0);
  });

  it("carries the outcome when a refusal arrives as a result on a route that cannot fail over", async () => {
    // An API key stops on failure (`credential-failure-policy.ts`), so there is
    // no second attempt: the refusal falls through to ordinary teardown and the
    // turn settles `completed` with nothing having run. An acknowledgement keyed
    // on the turn's OUTCOME consumes the outcome right here.
    (deps.prepareAgentEnv as unknown) = vi.fn().mockResolvedValue({
      turnRoute: { kind: "credential" as const, id: "key-1" },
    });
    deps.routeProfile = () => ({ billingMode: "key" as const, serviceId: "anthropic" });
    postAndResolve("set-a", "applied");

    await dispatch("unblock me", 1);
    expect(promptOfAttempt(0)).toContain("[ShipIt] Since your last turn");

    agents[0]!.emit("event", {
      type: "agent_result",
      status: "error",
      error: QUOTA_ERROR,
      sessionId: "agent-sid",
    });
    agents[0]!.emit("done", 0);
    await waitForTurn(() => settled.length > 0, "turn settled");

    expect(settled[0]?.status).toBe("completed");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  it("carries the outcome when the result itself reports a failure", async () => {
    // Not a quota refusal at all: an error result is a prompt that did not run,
    // and the adapter can report one with no `error` string on it.
    postAndResolve("set-a", "applied");

    await dispatch("unblock me", 1);
    expect(promptOfAttempt(0)).toContain("[ShipIt] Since your last turn");

    agents[0]!.emit("event", { type: "agent_result", status: "error", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitForTurn(() => settled.length > 0, "turn settled");

    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  it("carries the outcome when the refusal arrives as successful-looking assistant text", async () => {
    // The CLI reports its own limit as final text on a `success` result, so
    // "produced output" and `status === "success"` are both true of a turn that
    // ran nothing. Failover is off, so there is no later attempt to save it.
    (deps.prepareAgentEnv as unknown) = vi.fn().mockResolvedValue({
      turnRoute: { kind: "credential" as const, id: "key-1" },
    });
    deps.routeProfile = () => ({ billingMode: "key" as const, serviceId: "anthropic" });
    postAndResolve("set-a", "applied");

    await dispatch("unblock me", 1);
    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "You've hit your session limit · resets 5:10pm (UTC)" }],
    });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitForTurn(() => settled.length > 0, "turn settled");

    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });
});

describe("a resident streaming turn, which settles no turn of its own", () => {
  beforeEach(() => {
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
  });

  it("acknowledges on the result, so the notice does not repeat forever", async () => {
    postAndResolve("set-a", "applied");

    runner.dispatch(testDispatch({ text: "keep going" }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length > 0, "first run");
    expect(promptOfAttempt(0)).toContain("[ShipIt] Since your last turn");

    // A resident CLI reports its result and stays alive: no `done`, so the turn
    // never reaches `finishTurn`. Acknowledging at settlement would lose this
    // receipt for good — the next reuse discards this executor's listeners.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the outcome acknowledged",
    );

    runner.dispatch(testDispatch({ text: "and again" }));
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "steered second turn");
    expect(String(agents[0]!.sendUserMessage.mock.calls[0]?.[0])).toBe("and again");
  });

  it("does not acknowledge a result that arrives before its prompt is sent", async () => {
    // These listeners go live BEFORE environment preparation finishes, and a
    // resident CLI can complete a turn of its own in that gap. Acknowledging on
    // any result from the process loses the outcome for good when preparation
    // then fails and the prompt is never sent.
    postAndResolve("set-a", "applied");

    runner.dispatch(testDispatch({ text: "first" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "resident agent running",
    );
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the first outcome acknowledged",
    );

    // A second card, and a second turn whose environment preparation hangs.
    postAndResolve("set-b", "dismissed");
    let releasePrep: () => void = () => {};
    const prepBegan = { count: 0 };
    (deps.prepareAgentEnv as unknown) = vi.fn(async () => {
      prepBegan.count += 1;
      await new Promise<void>((resolve) => { releasePrep = resolve; });
      return undefined;
    });

    runner.dispatch(testDispatch({ text: "second" }));
    await waitForTurn(() => prepBegan.count === 1, "the second turn's env preparation");
    expect(agents[0]!.sendUserMessage.mock.calls).toHaveLength(0);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "flush");
    expect(proposals.listUnnotifiedResolved(SESSION).map((r) => r.target.key)).toEqual([KEY]);

    releasePrep();
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the prompt sent");
  });

  it("acknowledges on a reused process once its submission is confirmed", async () => {
    // The false side of `promptSubmitted` is covered above; this is the true
    // side on the reuse path, where the flag is set from `sendUserMessage`.
    postAndResolve("set-a", "applied");
    runner.dispatch(testDispatch({ text: "first" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "resident agent running",
    );
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the first outcome acknowledged",
    );

    postAndResolve("set-b", "dismissed");
    runner.dispatch(testDispatch({ text: "second" }));
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");
    expect(String(agents[0]!.sendUserMessage.mock.calls[0]?.[0]))
      .toContain("[ShipIt] Since your last turn");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the reused turn's outcome acknowledged",
    );
  });

  /*
    requirements.md records a turn the CLI wakes itself for as carrying no notice
    and waiting for the next dispatched turn — which is only true if the wake
    does not SPEND the receipt of the turn before it. The executor is re-armed
    for the adopted turn and keeps `promptSubmitted` and the dispatched prompt's
    receipts, so a wake whose result is the agent's own would otherwise settle a
    notice it never carried, and the next dispatched turn would lose the carry.
  */
  it("does not spend a failed turn's receipt on a turn the CLI woke itself for", async () => {
    postAndResolve("set-a", "applied");
    const autoCommit = deps.autoCommit as unknown as ReturnType<typeof vi.fn>;

    runner.dispatch(testDispatch({ text: "unblock me" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "resident agent running",
    );
    expect(promptOfAttempt(0)).toContain("[ShipIt] Since your last turn");

    // A failure that is neither auth nor quota, so nothing re-dispatches this
    // prompt: the outcome correctly stays pending for a later turn.
    agents[0]!.emit("event", { type: "agent_result", status: "error", sessionId: "agent-sid" });
    await waitForTurn(() => autoCommit.mock.calls.length === 1, "the failed turn's post-turn flow");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);

    // Background work finishes and the resident CLI resumes on its own. ShipIt
    // observes that turn rather than composing it, so it carries no notice.
    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => autoCommit.mock.calls.length === 2, "the adopted turn's post-turn flow");

    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);

    // And the next dispatched turn still carries it, which is what the carry is for.
    runner.dispatch(testDispatch({ text: "and now" }));
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the next dispatch");
    expect(String(agents[0]!.sendUserMessage.mock.calls[0]?.[0]))
      .toContain("[ShipIt] Since your last turn");
  });

  /**
   * Set up a resident process whose first turn has already been acknowledged,
   * then dispatch a second turn that carries a fresh outcome and park it inside
   * environment preparation. `release()` lets the prompt be sent.
   */
  async function dispatchIntoPreparationWindow(): Promise<{ release: () => void }> {
    postAndResolve("set-a", "applied");
    runner.dispatch(testDispatch({ text: "first" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "resident agent running",
    );
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the first outcome acknowledged",
    );

    postAndResolve("set-b", "dismissed");
    let releasePrep: () => void = () => {};
    const prepBegan = { count: 0 };
    (deps.prepareAgentEnv as unknown) = vi.fn(async () => {
      prepBegan.count += 1;
      await new Promise<void>((resolve) => { releasePrep = resolve; });
      return undefined;
    });
    runner.dispatch(testDispatch({ text: "second" }));
    await waitForTurn(() => prepBegan.count === 1, "the second turn's env preparation");
    return { release: () => releasePrep() };
  }

  /*
    The second ordering of the same defect. A wake that lands inside the new
    turn's environment preparation finds no result of this executor's to re-arm
    past, so the adoption flag is never set — and by the time the woken turn's
    result arrives the prompt HAS been submitted, so every state flag reads
    exactly as it does for a turn that ran the prompt. The result must be
    attributed to the turn it ends, not to what it looks like.
  */
  it("does not spend a newly dispatched prompt's receipt on a wake already in flight", async () => {
    const { release } = await dispatchIntoPreparationWindow();

    // Background work finishes and the resident CLI resumes on a turn of its own.
    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });

    release();
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");
    expect(String(agents[0]!.sendUserMessage.mock.calls[0]?.[0]))
      .toContain("[ShipIt] Since your last turn");

    // This result ends the woken turn. The prompt has been submitted but not read.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "the woken turn's result");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);

    // Nor does the result after it: which of the two ended the prompt's own turn
    // is exactly what the harness does not say, so neither settles the receipt.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "the result after it");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  /*
    The same window, reached through the other signal ShipIt reads as a turn the
    CLI began for itself: a top-level assistant block with no wake before it. The
    defect is a property of the ordering, not of which event announced the turn.
  */
  it("does not spend the receipt on a CLI-started turn that announced itself in output", async () => {
    const { release } = await dispatchIntoPreparationWindow();

    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Picking the background task back up." }],
    });

    release();
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "the CLI-started turn's result");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "the result after it");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  /*
    The result handler yields to an in-flight re-arm before it finishes, and the
    CLI keeps emitting across that yield. Which turn a result ends is fixed by
    the order events arrived in, so a replay landing inside the yield must not
    hand this result the turn that replay started.
  */
  it("does not let a turn beginning inside the re-arm yield answer an earlier result", async () => {
    const { release } = await dispatchIntoPreparationWindow();
    const autoCommit = deps.autoCommit as unknown as ReturnType<typeof vi.fn>;

    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    release();
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");
    const steered = String(agents[0]!.sendUserMessage.mock.calls[0]?.[0]);
    const commitsBefore = autoCommit.mock.calls.length;

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => autoCommit.mock.calls.length === commitsBefore + 1,
      "the first woken turn's post-turn flow",
    );

    // A second wake starts a re-arm; its result waits on that handover, and the
    // CLI picks the queued prompt up while the handover is still running.
    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-2", status: "completed" });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("event", { type: "agent_user_replay", text: steered });
    await waitForTurn(
      () => autoCommit.mock.calls.length === commitsBefore + 2,
      "the second woken turn's post-turn flow",
    );
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);

    // The prompt's own result is what settles it.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the prompt's own outcome acknowledged",
    );
  });

  /*
    A background task finishing during a queued prompt's own turn is the shape
    that makes the queued state undecidable rather than merely unhandled: the
    wake is indistinguishable from one starting a turn, and the prompt's own
    output is indistinguishable from that turn's. Nothing here acknowledges, and
    nothing here spends the receipt either.
  */
  it("holds the receipt through a queued prompt's turn rather than guessing", async () => {
    const { release } = await dispatchIntoPreparationWindow();

    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    release();
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "the woken turn ending");

    // The CLI works through the prompt it had queued, without replaying it, and
    // a second background task reports in while it does.
    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Reading the settings change." }],
    });
    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-2", status: "completed" });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "the queued prompt's own result");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  /*
    The same window, with the CLI absorbing the steered prompt into the turn it
    had already woken for — one result covering both. The replay is the harness
    saying it has read this exact prompt, so the notice did reach the agent and
    withholding it here would repeat a reminder requirement 8 exists to prevent.
  */
  /*
    The absorbed prompt again, without the replay that would have said so, and
    with the combined turn failing. The prompt's own state is left awaiting a
    result that will never come — so a LATER wake has to be recorded as a turn of
    its own, or its result spends a receipt for a prompt two turns behind it.
  */
  it("does not let a later wake settle a prompt absorbed into a failed turn", async () => {
    const { release } = await dispatchIntoPreparationWindow();

    const autoCommit = deps.autoCommit as unknown as ReturnType<typeof vi.fn>;
    const commitsBefore = autoCommit.mock.calls.length;

    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    release();
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");

    // The CLI absorbs the steered prompt into the turn it had woken for and that
    // turn fails, so nothing more is owed to the prompt.
    agents[0]!.emit("event", { type: "agent_result", status: "error", sessionId: "agent-sid" });
    await waitForTurn(
      () => autoCommit.mock.calls.length === commitsBefore + 1,
      "the combined turn's post-turn flow",
    );

    // The re-arm this wake starts completes after the result below is emitted,
    // so the acknowledgement is decided inside that turn's post-turn flow.
    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-2", status: "completed" });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => autoCommit.mock.calls.length === commitsBefore + 2,
      "the later woken turn's post-turn flow",
    );
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  it("acknowledges when the CLI replays the prompt into a turn it had woken for", async () => {
    const { release } = await dispatchIntoPreparationWindow();

    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    release();
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");
    const steered = String(agents[0]!.sendUserMessage.mock.calls[0]?.[0]);

    agents[0]!.emit("event", { type: "agent_user_replay", text: steered });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the outcome acknowledged on the replayed prompt's result",
    );
  });

  it("does not acknowledge when a proxied submission is never accepted", async () => {
    // `ProxyAgentProcess.sendUserMessage` returns while its worker request is
    // still in flight, so returning from it proves nothing. A resident CLI can
    // finish a turn of its own in that window and the request can then fail.
    postAndResolve("set-a", "applied");

    let rejectSubmission: (err: Error) => void = () => {};
    const submission = new Promise<void>((_resolve, reject) => { rejectSubmission = reject; });
    submission.catch(() => { /* the adapter's error path owns the turn */ });
    (deps.agentFactory as unknown) = () => {
      const agent = makeFakeAgent() as FakeAgent & { submissionSettled(): Promise<unknown> };
      agent.submissionSettled = () => submission;
      agents.push(agent);
      return agent;
    };

    runner.dispatch(testDispatch({ text: "unblock me" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "the proxied agent run",
    );
    expect(promptOfAttempt(0)).toContain("[ShipIt] Since your last turn");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "flush");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);

    rejectSubmission(new Error("the session worker never accepted the prompt"));
    await waitForTurn(() => true, "flush");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  it("does not let a late submission confirmation put a finished prompt back in flight", async () => {
    // The worker's answer to `/agent/message` and the CLI's events travel
    // separately, so a confirmation can land after the result it confirms. The
    // prompt ran and failed; re-arming it on the confirmation would hand its
    // receipt to whatever the CLI does next.
    postAndResolve("set-a", "applied");
    runner.dispatch(testDispatch({ text: "first" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "resident agent running",
    );
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the first outcome acknowledged",
    );

    postAndResolve("set-b", "dismissed");
    let acceptSubmission: () => void = () => {};
    const submission = new Promise<void>((resolve) => { acceptSubmission = resolve; });
    (agents[0]! as unknown as { submissionSettled(): Promise<unknown> }).submissionSettled =
      () => submission;

    runner.dispatch(testDispatch({ text: "second" }));
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");
    const steered = String(agents[0]!.sendUserMessage.mock.calls[0]?.[0]);

    // The CLI reads the prompt and its turn fails, all before the worker answers.
    const autoCommit = deps.autoCommit as unknown as ReturnType<typeof vi.fn>;
    const commitsBefore = autoCommit.mock.calls.length;
    agents[0]!.emit("event", { type: "agent_user_replay", text: steered });
    agents[0]!.emit("event", { type: "agent_result", status: "error", sessionId: "agent-sid" });
    await waitForTurn(
      () => autoCommit.mock.calls.length === commitsBefore + 1,
      "the failed turn's post-turn flow",
    );
    acceptSubmission();
    await waitForTurn(() => true, "the confirmation landing after it");

    // The prompt ran and its turn ended, so whatever the CLI does next is a turn
    // of its own whether or not it announces itself.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "the next result");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);

    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => autoCommit.mock.calls.length === commitsBefore + 2,
      "the woken turn's post-turn flow",
    );
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  it("does not let a confirmation that follows a result claim the running turn", async () => {
    // The same late confirmation, with no replay to have moved the prompt first.
    // A result passed while the worker's answer was in flight, so the prompt did
    // not necessarily reach a turn of its own — it waits rather than claiming
    // the CLI's attention, and a later wake is still a turn in its own right.
    postAndResolve("set-a", "applied");
    const autoCommit = deps.autoCommit as unknown as ReturnType<typeof vi.fn>;

    runner.dispatch(testDispatch({ text: "first" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "resident agent running",
    );
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the first outcome acknowledged",
    );

    postAndResolve("set-b", "dismissed");
    let acceptSubmission: () => void = () => {};
    const submission = new Promise<void>((resolve) => { acceptSubmission = resolve; });
    (agents[0]! as unknown as { submissionSettled(): Promise<unknown> }).submissionSettled =
      () => submission;

    runner.dispatch(testDispatch({ text: "second" }));
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");
    const commitsBefore = autoCommit.mock.calls.length;

    agents[0]!.emit("event", { type: "agent_result", status: "error", sessionId: "agent-sid" });
    await waitForTurn(
      () => autoCommit.mock.calls.length === commitsBefore + 1,
      "the failed turn's post-turn flow",
    );
    acceptSubmission();
    await waitForTurn(() => true, "the confirmation landing after it");

    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => autoCommit.mock.calls.length === commitsBefore + 2,
      "the woken turn's post-turn flow",
    );
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  it("does not let a late confirmation unseat a prompt the CLI has taken", async () => {
    // The confirmation is the weakest of the three signals, so it sets the
    // prompt's state only when nothing stronger has. Here a result passed while
    // it was in flight and the CLI then replayed the prompt: the replay is proof
    // the prompt is the running turn, and the confirmation must not walk it back
    // to one that can never acknowledge.
    postAndResolve("set-a", "applied");
    runner.dispatch(testDispatch({ text: "first" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "resident agent running",
    );
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the first outcome acknowledged",
    );

    postAndResolve("set-b", "dismissed");
    let acceptSubmission: () => void = () => {};
    const submission = new Promise<void>((resolve) => { acceptSubmission = resolve; });
    (agents[0]! as unknown as { submissionSettled(): Promise<unknown> }).submissionSettled =
      () => submission;

    runner.dispatch(testDispatch({ text: "second" }));
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length > 0, "the steered prompt");
    const steered = String(agents[0]!.sendUserMessage.mock.calls[0]?.[0]);

    // A turn the CLI had already been running ends, then it takes the prompt.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => true, "the earlier turn's result");
    agents[0]!.emit("event", { type: "agent_user_replay", text: steered });
    acceptSubmission();
    await waitForTurn(() => true, "the confirmation landing after both");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the prompt's own outcome acknowledged",
    );
  });

  it("does not let a replay arriving after the turn ended re-open it", async () => {
    // This executor's prompt has one turn, and its acknowledgement was decided
    // when that turn ended. A replay landing after it — the CLI re-emitting a
    // message it has already consumed — must not make the next CLI-started turn
    // look like this prompt's.
    postAndResolve("set-a", "applied");
    const autoCommit = deps.autoCommit as unknown as ReturnType<typeof vi.fn>;

    runner.dispatch(testDispatch({ text: "unblock me" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "resident agent running",
    );
    const sent = promptOfAttempt(0);
    agents[0]!.emit("event", { type: "agent_result", status: "error", sessionId: "agent-sid" });
    await waitForTurn(() => autoCommit.mock.calls.length === 1, "the failed turn's post-turn flow");

    agents[0]!.emit("event", { type: "agent_user_replay", text: sent });
    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => autoCommit.mock.calls.length === 2, "the woken turn's post-turn flow");
    expect(proposals.listUnnotifiedResolved(SESSION)).toHaveLength(1);
  });

  it("acknowledges on a freshly spawned process whose output beats its submission", async () => {
    // The same in-flight window, on a process spawned FOR this prompt. Output
    // arriving before the worker confirms the submission is this prompt's own
    // work — there is no earlier turn on a new process for it to belong to —
    // so reading it as a turn the CLI started would withhold a delivered notice.
    postAndResolve("set-a", "applied");

    let acceptSubmission: () => void = () => {};
    const submission = new Promise<void>((resolve) => { acceptSubmission = resolve; });
    (deps.agentFactory as unknown) = () => {
      const agent = makeFakeAgent() as FakeAgent & { submissionSettled(): Promise<unknown> };
      agent.submissionSettled = () => submission;
      agents.push(agent);
      return agent;
    };

    runner.dispatch(testDispatch({ text: "unblock me" }));
    await waitForTurn(
      () => agents.length > 0 && agents[0]!.run.mock.calls.length > 0,
      "the proxied agent run",
    );

    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "On it." }],
    });
    acceptSubmission();
    await waitForTurn(() => true, "flush");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(
      () => proposals.listUnnotifiedResolved(SESSION).length === 0,
      "the outcome acknowledged",
    );
  });
});
