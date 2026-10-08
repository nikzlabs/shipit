import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "../session-runner.js";
import type { AgentId, WsServerMessage } from "../../shared/types.js";
import { ChatHistoryManager, type PersistedMessage } from "../chat-history.js";
import { DatabaseManager } from "../../shared/database.js";
import { emitChatCard } from "../chat-card-persistence.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  flushTurn,
  waitForTurn,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

// planning#645: one attempt can end through several terminal events, and each used to
// rebuild the turn into history, so every row of an already-final turn was saved again.
const CARD: PersistedMessage = {
  role: "assistant",
  text: "",
  voiceNote: { id: "card-645", headline: "A side-channel card", kind: "authored", createdAt: "t" },
};

async function startTurn(opts: { healFails?: boolean } = {}): Promise<{
  runner: SessionRunner;
  agent: FakeAgent;
  history: ChatHistoryManager;
}> {
  const history = new ChatHistoryManager(new DatabaseManager(":memory:"));
  const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
  const agents: FakeAgent[] = [];
  const { deps } = makeDispatchTurnDeps(agents, []);
  deps.listenerDeps.chatHistoryManager = history as never;
  if (opts.healFails) deps.ensureAgentTokenFresh = vi.fn().mockResolvedValue(false);
  runner.setSystemTurnDeps(deps);
  runner.dispatch(testDispatch({ text: "do work" }));
  await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "agent run");
  return { runner, agent: agents[0]!, history };
}

function postCard(runner: SessionRunner, history: ChatHistoryManager): void {
  emitChatCard(
    runner,
    { type: "voice_note", sessionId: "s1", ...CARD.voiceNote! } as WsServerMessage,
    CARD,
    { chatHistoryManager: history, sessionId: "s1" },
  );
}

async function settle(runner: SessionRunner): Promise<void> {
  await waitForTurn(() => !runner.running, "turn finished");
  for (let i = 0; i < 20; i++) await flushTurn();
}

const cards = (history: ChatHistoryManager) => history.load("s1").filter((m) => m.voiceNote?.id === "card-645");

describe("a turn's rows are saved once, however many terminal events end it (planning#645)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a card posted before the agent fails sign-in is saved once when the agent also reports a result", async () => {
    const { runner, agent, history } = await startTurn();
    postCard(runner, history);

    agent.emit("auth_required");
    agent.emit("event", { type: "agent_result", status: "error", sessionId: "cli", error: "Not logged in" });
    agent.emit("done", 0);
    await settle(runner);

    expect(cards(history)).toHaveLength(1);
    expect(cards(history)[0]!.inProgress).toBeUndefined();
    runner.dispose({ force: true });
  });

  it("a card is saved once when the killed agent reports a process error before the failed heal surfaces", async () => {
    const { runner, agent, history } = await startTurn({ healFails: true });
    postCard(runner, history);

    agent.emit("auth_required");
    agent.emit("error", new Error("worker request aborted"));
    agent.emit("done", 1);
    await settle(runner);

    expect(cards(history)).toHaveLength(1);
    expect(history.load("s1").some((m) => m.isError && m.text.includes("not authenticated"))).toBe(true);
    runner.dispose({ force: true });
  });

  it("a process death that reports both a result and an error saves the partial output once", async () => {
    const { runner, agent, history } = await startTurn();
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Partial output" }] });
    postCard(runner, history);

    agent.emit("event", { type: "agent_result", status: "error", sessionId: "cli", error: "API Error: 500" });
    agent.emit("error", new Error("process exited"));
    agent.emit("done", 1);
    await settle(runner);

    const rows = history.load("s1");
    expect(rows.filter((m) => m.text === "Partial output")).toHaveLength(1);
    expect(cards(history)).toHaveLength(1);
    runner.dispose({ force: true });
  });
});
