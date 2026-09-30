import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { ChatHistoryManager } from "../chat-history.js";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import type { TurnOutcome } from "../turn-settlement.js";
import { prepareRepoSessionOutcomeNotice } from "../services/repo-session-outcome-notice.js";
import { prepareSessionMessageOutcomeNotice } from "../services/session-message-outcome-notice.js";
import {
  makeDispatchTurnDeps,
  testDispatch,
  waitForTurn,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

/**
 * docs/303-cross-repo-session-proposal req 11 and docs/314-session-message-proposal
 * req 14 on the dispatch path (`dispatched-turn.ts`); the WebSocket send path is
 * covered in `propose-repo-session-route.test.ts` and
 * `propose-session-message-deliver.test.ts`.
 */

const SESSION = "sess-1";

let dbManager: DatabaseManager;
let chatHistoryManager: ChatHistoryManager;
let runner: SessionRunner;
let agents: FakeAgent[];
let settled: TurnOutcome[];

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  chatHistoryManager = new ChatHistoryManager(dbManager);
  agents = [];
  settled = [];

  const { deps } = makeDispatchTurnDeps(agents, []);
  // Echo the real prompt through, so the assertions read what the agent was given.
  deps.buildRunParams = vi.fn(async (_sessionId: string, _agentId: AgentId, prompt: string) => ({
    prompt,
    cwd: "/tmp/s1",
  })) as unknown as SystemTurnDeps["buildRunParams"];
  deps.repoSessionOutcomeNotice = (sessionId) =>
    prepareRepoSessionOutcomeNotice({ chatHistoryManager }, sessionId);
  deps.sessionMessageOutcomeNotice = (sessionId) =>
    prepareSessionMessageOutcomeNotice({ chatHistoryManager }, sessionId);

  runner = new SessionRunner({
    sessionId: SESSION,
    sessionDir: "/tmp/s1",
    defaultAgentId: "claude" as AgentId,
  });
  runner.setSystemTurnDeps(deps);
});

afterEach(() => {
  runner.dispose({ force: true });
  dbManager.close();
  vi.restoreAllMocks();
});

function declinedCard(cardId: string): void {
  chatHistoryManager.append(SESSION, {
    role: "assistant",
    text: "",
    repoSessionProposal: {
      cardId,
      repo: "acme/api",
      repoUrl: "https://github.com/acme/api.git",
      registered: true,
      title: "Add cursor pagination",
      prompt: "Add cursor pagination to GET /events.",
      createdAt: "2026-09-30T10:00:00.000Z",
      state: "declined",
      declinedAt: "2026-09-30T10:05:00.000Z",
    },
  });
}

async function dispatch(text: string, opts: { systemTurn?: boolean } = {}): Promise<string> {
  const ran = () => agents.filter((a) => a.run.mock.calls.length > 0);
  const before = ran().length;
  runner.dispatch(testDispatch({
    text,
    ...opts,
    onTurnComplete: (outcome) => { settled.push(outcome); },
  }));
  await waitForTurn(() => ran().length === before + 1, `agent run ${before + 1}`);
  const params = ran()[before]!.run.mock.calls[0]?.[0] as { prompt?: string };
  return String(params.prompt);
}

async function completeTurn(): Promise<void> {
  const agent = [...agents].reverse().find((a) => a.run.mock.calls.length > 0)!;
  const before = settled.length;
  agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
  agent.emit("done", 0);
  await waitForTurn(() => settled.length > before, "turn settled");
}

describe("a card the user acted on reaches the agent's next dispatched turn", () => {
  it("is delivered once and does not repeat on the turn after", async () => {
    declinedCard("rsp-a");

    const first = await dispatch("keep going");
    expect(first).toContain("[ShipIt] Since your last turn, the user acted on a card you posted");
    expect(first).toContain("DECLINED by the user");
    expect(first.endsWith("keep going")).toBe(true);
    await completeTurn();

    const second = await dispatch("and again");
    expect(second).toBe("and again");
    await completeTurn();
  });

  it("rides an automatic turn ShipIt runs by itself, since req 11 names no kind of turn", async () => {
    declinedCard("rsp-a");

    const prompt = await dispatch("CI is failing. Fix it.", { systemTurn: true });
    expect(prompt).toContain("DECLINED by the user");
    await completeTurn();

    expect(chatHistoryManager.findRepoSessionProposalCard(SESSION, "rsp-a")?.agentNotifiedState)
      .toBe("declined");
  });

  it("keeps the outcome for a later turn when the agent never answered", async () => {
    declinedCard("rsp-a");

    await dispatch("unblock me");
    const agent = agents.find((a) => a.run.mock.calls.length > 0)!;
    agent.emit("event", { type: "agent_result", status: "error", sessionId: "agent-sid" });
    agent.emit("done", 0);
    await waitForTurn(() => settled.length > 0, "turn settled");

    expect(await dispatch("try again")).toContain("DECLINED by the user");
    await completeTurn();
  });
});

describe("a session-message card the user acted on reaches the next dispatched turn", () => {
  it("is delivered once, alongside a repository card's outcome", async () => {
    declinedCard("rsp-a");
    chatHistoryManager.append(SESSION, {
      role: "assistant",
      text: "",
      sessionMessageProposal: {
        cardId: "smp-a",
        targetSessionId: "ses_root",
        targetTitle: "Orchestrator",
        message: "The parser slice is done.",
        createdAt: "2026-09-30T10:00:00.000Z",
        state: "delivered",
        queued: false,
      },
    });

    const first = await dispatch("keep going");
    expect(first).toContain('acme/api "Add cursor pagination" — DECLINED by the user');
    expect(first).toContain('session ses_root "Orchestrator" — DELIVERED by the user');
    await completeTurn();

    expect(chatHistoryManager.findSessionMessageProposalCard(SESSION, "smp-a")?.agentNotifiedState)
      .toBe("delivered");
    expect(await dispatch("and again")).toBe("and again");
    await completeTurn();
  });
});
