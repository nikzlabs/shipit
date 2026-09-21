import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { AgentId, SessionStatus } from "../shared/types.js";
import {
  formatSessionStatusContext,
  recordSessionStatus,
  refreshStatusContextInPrompt,
  takeOfferedActions,
} from "./services/session-status.js";
import type { SessionStatusDeps } from "./services/session-status.js";
import { testDispatch } from "./integration_tests/dispatch-test-helpers.js";

/**
 * docs/303 req 35 — a turn is submitted more than once, and the prompt it was given the
 * first time is a snapshot. A quota failover, an auth heal and the lost-conversation
 * recovery all re-enter `executeAgentTurn` with that same string, so the retried attempt
 * used to read the card as it stood BEFORE the failed attempt's work: the `session_status`
 * write the tool had reported as saved was gone from it, and an offer the user's submit
 * had already taken was printed as still outstanding, payload and all. The agent then
 * redid work it had finished, and the user was told about it twice.
 *
 * The stored card was never wrong — `sessions.session_status` held the newer write and the
 * `takenAt` throughout. Only what reached the agent had rewound.
 */

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(): FakeAgent {
  const agent = new EventEmitter() as FakeAgent;
  agent.run = vi.fn();
  agent.kill = vi.fn();
  agent.setPermissionMode = vi.fn();
  agent.sendUserMessage = vi.fn();
  return agent;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(fn: () => boolean, label = "condition", timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const QUOTA_ERROR = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";

/** The message the status card composes when the user ticks an offer and submits it. */
const SUBMIT_MESSAGE =
  "[Action card → Submit] I approved this action.\n\n1. Open the follow-up PR for the rate-limit edge case";

const OFFER_PAYLOAD = "Open the follow-up PR for the rate-limit edge case";

function seededCard(): SessionStatus {
  return {
    status: "Routes done; the webhook is not started.",
    actions: [{
      id: "follow-up",
      offerId: "o1",
      label: "Open the follow-up PR",
      description: "Files the rate-limit edge case as its own PR.",
      payload: OFFER_PAYLOAD,
      offeredAt: "2026-09-20T09:00:00.000Z",
      offeredSeq: 0,
    }],
    fresh: true,
    writeSeq: 1,
    turnSeq: 1,
  };
}

function harness(opts: { card?: SessionStatus; statusCardEnabled?: () => boolean } = {}) {
  const cards = new Map<string, SessionStatus | undefined>();
  if (opts.card) cards.set("s1", opts.card);

  const sessionManager = {
    setAgentSessionId: vi.fn(),
    setLastTurnErrored: vi.fn(),
    get: (id: string) => ({ id, sessionStatus: cards.get(id) }),
    track: vi.fn(),
    setMuted: vi.fn(),
    list: () => [],
    setSessionStatus: (id: string, status: SessionStatus | null) => {
      cards.set(id, status ?? undefined);
    },
    sessionIdsWithStatus: () => [...cards.keys()],
  };

  const agents: FakeAgent[] = [];
  const prompts: string[] = [];
  const runner = new SessionRunner({
    sessionId: "s1",
    sessionDir: "/tmp/turn-retry-status",
    defaultAgentId: "claude" as AgentId,
  });

  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const a = makeFakeAgent();
      agents.push(a);
      return a as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
    autoCommit: async () => ({
      commitHash: null,
      parentHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [],
      unreadable: null,
    }),
    scheduleAutoPush: vi.fn(),
    prepareAgentEnv: (async () => undefined) as never,
    statusCardEnabled: opts.statusCardEnabled ?? (() => true),
    sessionStatusContext: () =>
      (opts.statusCardEnabled?.() ?? true)
        ? formatSessionStatusContext(cards.get("s1"))
        : "",
    listenerDeps: {
      sessionManager: sessionManager as never,
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        finalizeInProgress: vi.fn(),
        append: vi.fn(),
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: {
        record: vi.fn(),
        getSessionUsage: vi.fn(),
        getSessionTokenTotals: vi.fn(),
      } as never,
      sseBroadcast: vi.fn(),
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn(async (_sessionId: string, _agentId: AgentId, prompt: string) => {
      prompts.push(prompt);
      return { prompt, cwd: "/tmp/turn-retry-status" };
    }) as never,
  };
  runner.setSystemTurnDeps(deps);

  const statusDeps: SessionStatusDeps = {
    sessionManager: sessionManager as unknown as SessionStatusDeps["sessionManager"],
    sseBroadcast: vi.fn(),
  };

  return {
    runner,
    agents,
    prompts,
    card: () => cards.get("s1"),
    /** What accepting the user's submit does: the offer is taken as the message lands. */
    userSubmitsTheOffer: () => takeOfferedActions(statusDeps, "s1", ["o1"]),
    /** What an accepted `session_status` call does. */
    agentWritesCard: async (status: string, lastTurn: string) => {
      runner.statusUpdated = true;
      await recordSessionStatus(statusDeps, "s1", { status, lastTurn });
    },
  };
}

describe("a retried attempt reads the card as it stands (docs/303 req 35)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries the session_status write the failed attempt made, and the offer it took", async () => {
    const h = harness({ card: seededCard() });

    h.runner.dispatch(testDispatch({ text: SUBMIT_MESSAGE }));
    await waitFor(
      () => h.agents.length === 1 && h.agents[0]!.run.mock.calls.length === 1,
      "the first attempt",
    );

    // The message was accepted, so the offer is taken; then the agent does the work and
    // writes the card, and the tool answers that the card is up to date.
    await h.userSubmitsTheOffer();
    await h.agentWritesCard("Follow-up PR #212 is open and ready to merge.", "Opened PR #212.");

    // Only then does the provider refuse on quota, and ShipIt re-runs the turn.
    h.agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(
      () => h.agents.length === 2 && h.agents[1]!.run.mock.calls.length === 1,
      "the retried attempt",
    );

    const retried = h.prompts[1]!;
    // The write the tool reported as saved is what the retried attempt reads.
    expect(retried).toContain("Follow-up PR #212 is open and ready to merge.");
    expect(retried).not.toContain("the webhook is not started");
    // And the offer the user submitted is marked sent, so its payload is a record of work
    // done rather than an instruction to do it again.
    expect(retried).toContain("ALREADY SENT to you");

    // The stored card was right all along; only the prompt had rewound.
    expect(h.card()?.status).toBe("Follow-up PR #212 is open and ready to merge.");
    expect(h.card()?.actions[0]?.takenAt).toBeTruthy();

    h.agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    h.agents[1]!.emit("done", 0);
    await waitFor(() => !h.runner.running, "the turn finished");
    h.runner.dispose({ force: true });
  });

  it("gives no block to a turn composed without one, however many times it is retried", async () => {
    // A compaction, a verbatim command and a driver-owned turn carry no card block on
    // purpose; a retry must not hand them one it composed itself.
    const h = harness({ card: seededCard() });

    h.runner.dispatch(testDispatch({ text: "/compact", compactContext: true }));
    await waitFor(
      () => h.agents.length === 1 && h.agents[0]!.run.mock.calls.length === 1,
      "the first attempt",
    );
    expect(h.prompts[0]).not.toContain("<session_status_card>");

    h.agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(
      () => h.agents.length === 2 && h.agents[1]!.run.mock.calls.length === 1,
      "the retried attempt",
    );
    expect(h.prompts[1]).not.toContain("<session_status_card>");

    h.agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    h.agents[1]!.emit("done", 0);
    await waitFor(() => !h.runner.running, "the turn finished");
    h.runner.dispose({ force: true });
  });

  it("leaves the prompt alone when the setting goes off mid-turn (req 21)", async () => {
    let on = true;
    const h = harness({ card: seededCard(), statusCardEnabled: () => on });

    h.runner.dispatch(testDispatch({ text: SUBMIT_MESSAGE }));
    await waitFor(
      () => h.agents.length === 1 && h.agents[0]!.run.mock.calls.length === 1,
      "the first attempt",
    );
    expect(h.prompts[0]).toContain("<session_status_card>");

    on = false;
    h.agents[0]!.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(
      () => h.agents.length === 2 && h.agents[1]!.run.mock.calls.length === 1,
      "the retried attempt",
    );
    // With the card off it is not ShipIt's to edit, so the attempt keeps what it had.
    expect(h.prompts[1]).toBe(h.prompts[0]);

    h.agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    h.agents[1]!.emit("done", 0);
    await waitFor(() => !h.runner.running, "the turn finished");
    h.runner.dispose({ force: true });
  });
});

describe("refreshStatusContextInPrompt", () => {
  const PREVIOUS = "<session_status_card>\nold\n</session_status_card>";
  const CURRENT = "<session_status_card>\nnew\n</session_status_card>";

  it("swaps the composition site's own rendering in place", () => {
    const prompt = `A notice.\n\n${PREVIOUS}\n\nDo the thing.`;
    expect(refreshStatusContextInPrompt(prompt, PREVIOUS, CURRENT))
      .toBe(`A notice.\n\n${CURRENT}\n\nDo the thing.`);
  });

  it("leaves a prompt that carries no block alone", () => {
    const prompt = "Summarise the conversation.";
    expect(refreshStatusContextInPrompt(prompt, undefined, CURRENT)).toBe(prompt);
  });

  it("leaves the prompt alone when there is no current rendering", () => {
    const prompt = `${PREVIOUS}\n\nDo the thing.`;
    expect(refreshStatusContextInPrompt(prompt, PREVIOUS, "")).toBe(prompt);
  });

  /**
   * The swap is an exact replacement of what the composition site inserted, never a search
   * for the tags: a user message quoting the block must not be rewritten under the user.
   */
  it("does not touch a quoted block in the user's own message", () => {
    const prompt = `Why does ${PREVIOUS} say that?`;
    expect(refreshStatusContextInPrompt(prompt, undefined, CURRENT)).toBe(prompt);
  });
});
