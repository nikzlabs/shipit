import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { ChatHistoryManager } from "./chat-history.js";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import { executeAgentTurn, type TurnInput } from "./turn-executor.js";
import { buildTurnMessages } from "./ws-handlers/agent-listeners.js";
import { emitNoticeInTurn } from "./chat-card-persistence.js";
import type { AgentId } from "../shared/types.js";
import {
  makeFakeAgent,
  makeDispatchTurnDeps,
  flushTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";

const SESSION = "sess-failover";
const NOTICE = "Claude2 is out of quota — continuing this session on Claude1.";

describe("stale turn teardown is turn-scoped", () => {
  let dbManager: DatabaseManager;
  let chatHistory: ChatHistoryManager;
  let runner: SessionRunner;
  let agents: FakeAgent[];
  let deps: SystemTurnDeps;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    chatHistory = new ChatHistoryManager(dbManager);
    runner = new SessionRunner({
      sessionId: SESSION,
      sessionDir: "/tmp/does-not-exist-stale-teardown",
      defaultAgentId: "claude" as AgentId,
    });
    agents = [];
    ({ deps } = makeDispatchTurnDeps(agents, []));
    deps.listenerDeps = { ...deps.listenerDeps, chatHistoryManager: chatHistory };
  });

  afterEach(() => {
    dbManager.close();
    vi.restoreAllMocks();
  });

  const wsOnInterruptedTurn = (): void => {
    const partial = buildTurnMessages(
      runner.chatMessageGroups,
      runner.steeredMessages ?? [],
      runner.recordedCards ?? [],
      { inProgress: false },
    );
    chatHistory.replaceInProgress(SESSION, partial);
    chatHistory.finalizeInProgress(SESSION);
    runner.clearTurnEventBuffer();
  };

  const baseInput = (text: string): TurnInput => ({
    agentId: "claude" as AgentId,
    sessionId: SESSION,
    prompt: text,
    userText: text,
    emitUserEcho: false,
    persistUserMessage: (sid) => chatHistory.append(sid, { role: "user", text }),
    isNewSession: false,
    fallbackTitle: text,
    turnStartHeadHash: null,
    drainNext: async () => {},
    emit: (m) => runner.emitMessage(m),
    useStreaming: true,
    emitErrorOnNoResult: true,
    onInterruptedTurn: wsOnInterruptedTurn,
  });

  const startTurn = async (
    text: string,
    opts?: { emitFailoverNotice?: boolean },
  ): Promise<FakeAgent> => {
    const agent = makeFakeAgent();
    runner.setAgent(agent as never);
    const turnDeps: SystemTurnDeps = {
      ...deps,
      ...(opts?.emitFailoverNotice
        ? {
            prepareAgentEnv: async () => {
              emitNoticeInTurn(runner, SESSION, NOTICE, chatHistory);
              return undefined;
            },
          }
        : {}),
    };
    await executeAgentTurn(runner, turnDeps, agent as never, baseInput(text));
    return agent;
  };

  const noticeRows = () =>
    chatHistory.load(SESSION).filter((m) => m.notice && m.text === NOTICE);

  it("persists the failover notice exactly ONCE when a stale done lands after env-prep", async () => {
    const agentA = await startTurn("turn A");

    const agentB = await startTurn("turn B", { emitFailoverNotice: true });
    expect(
      chatHistory.load(SESSION).filter((m) => m.text === NOTICE && m.inProgress),
    ).toHaveLength(1);

    agentA.emit("done", 143);
    await flushTurn();

    expect(runner.running).toBe(true);

    agentB.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agentB.emit("done", 0);
    await flushTurn();

    expect(noticeRows()).toHaveLength(1);
    expect(noticeRows()[0]!.inProgress).toBeUndefined();
  });

  it("does not write a stale no-result error row into the successor's transcript", async () => {
    const agentA = await startTurn("turn A");
    const agentB = await startTurn("turn B", { emitFailoverNotice: true });

    agentA.emit("done", 143);
    await flushTurn();

    agentB.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agentB.emit("done", 0);
    await flushTurn();

    expect(chatHistory.load(SESSION).filter((m) => m.isError)).toHaveLength(0);
  });

  it("a stale adapter-level error does not finalize the successor's rows or clear its running flag", async () => {
    const agentA = await startTurn("turn A");
    const agentB = await startTurn("turn B", { emitFailoverNotice: true });
    expect(runner.running).toBe(true);

    agentA.emit("error", new Error("Worker request timed out after 10000ms: /agent/message"));
    await flushTurn();

    expect(runner.running).toBe(true);
    expect(
      chatHistory.load(SESSION).filter((m) => m.text === NOTICE && m.inProgress),
    ).toHaveLength(1);
    expect(chatHistory.load(SESSION).filter((m) => m.isError)).toHaveLength(0);

    agentB.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agentB.emit("done", 0);
    await flushTurn();

    expect(noticeRows()).toHaveLength(1);
  });

  it("a stale QUOTA-shaped error neither benches the account nor displaces the successor", async () => {
    const exhausted = vi.fn();
    deps.listenerDeps = { ...deps.listenerDeps, markSessionAccountExhausted: exhausted };
    const agentA = await startTurn("turn A");
    const agentB = await startTurn("turn B", { emitFailoverNotice: true });

    agentA.emit("error", new Error("Claude usage limit reached · resets 5:10pm (UTC)"));
    await flushTurn();

    expect(exhausted).not.toHaveBeenCalled();
    expect(agents).toHaveLength(0);
    expect(runner.getAgent()).toBe(agentB as never);
    expect(runner.running).toBe(true);

    agentB.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agentB.emit("done", 0);
    await flushTurn();

    expect(noticeRows()).toHaveLength(1);
  });

  it("still finalizes a genuinely interrupted turn's partial work (no successor)", async () => {
    const agentA = await startTurn("turn A", { emitFailoverNotice: true });

    agentA.emit("done", 143);
    await flushTurn();

    expect(noticeRows()).toHaveLength(1);
    expect(noticeRows()[0]!.inProgress).toBeUndefined();
    expect(chatHistory.load(SESSION).filter((m) => m.isError)).toHaveLength(1);
  });

  it("still writes the error teardown for a crash of the CURRENT turn", async () => {
    const agentA = await startTurn("turn A", { emitFailoverNotice: true });

    agentA.emit("error", new Error("spawn failed"));
    await flushTurn();

    expect(runner.running).toBe(false);
    expect(noticeRows()).toHaveLength(1);
    expect(noticeRows()[0]!.inProgress).toBeUndefined();
    expect(
      chatHistory.load(SESSION).filter((m) => m.isError && m.text?.includes("spawn failed")),
    ).toHaveLength(1);
  });
});
