import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { SettingsProposalStore } from "../settings-proposal-store.js";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import type { TurnOutcome } from "../turn-settlement.js";
import { ProviderRouteUnavailableError } from "../provider-route-preflight.js";
import { prepareSettingsOutcomeNotice } from "../services/settings-outcome-notice.js";
import {
  postSettingsProposal,
  transitionSettingsProposal,
} from "../services/settings-proposal.js";
import {
  makeDispatchTurnDeps,
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
    from: over.from ?? "off",
    to: over.to ?? "on",
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
});
