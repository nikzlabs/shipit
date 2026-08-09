/**
 * A superseded turn's teardown must not touch chat-history rows the SUCCESSOR
 * turn owns (the double account-failover-notice incident, prod session
 * 70c910f1, 2026-08-09).
 *
 * The shape: turn B starts while turn A's teardown is still pending (the
 * failover pre-check killed A's resident process; its late `done` / local
 * adapter `error` unwinds asynchronously). B's env-prep emits the one-time
 * "account X is out of quota — continuing on Y" notice via `emitNoticeInTurn`,
 * which records it on the runner AND writes it as an `in_progress=1` row.
 * A's teardown then runs a session-scoped finalize (`onInterruptedTurn` /
 * the listener error path), which reads the runner's CURRENT accumulators and
 * flips ALL in-progress rows to `in_progress=0` — including B's notice. B still
 * holds the notice in `recordedCards`, so its next rebuild re-inserts it;
 * `replaceInProgress` deletes only `in_progress=1` rows, so the finalized first
 * copy survives and the transcript ends with TWO permanent notice bubbles.
 *
 * Fixed by the `turnEpoch` guard (`resetRunnerTurnState` bumps it; stale
 * teardowns compare and stand down) plus the `replaceInProgress` noticeId
 * dedupe as defense-in-depth. These tests drive the REAL `executeAgentTurn` +
 * `wireAgentListeners` + `ChatHistoryManager` stack with fake agents.
 */
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
    // Swap the mocked history manager for the real thing — row counts are the
    // whole point of these tests.
    deps.listenerDeps = { ...deps.listenerDeps, chatHistoryManager: chatHistory };
  });

  afterEach(() => {
    dbManager.close();
    vi.restoreAllMocks();
  });

  /** The WS adapter's `onInterruptedTurn`, verbatim in shape (agent-execution.ts). */
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
            // What `prepareSessionAgentEnvironment` does on an account
            // failover (session-agent-env.ts): emit the one-time notice
            // in-turn, recorded + persisted as an in_progress row.
            prepareAgentEnv: async () => {
              emitNoticeInTurn(runner, SESSION, NOTICE, chatHistory);
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
    // Turn A runs and is cut short before producing a result (the user
    // interrupted / the failover pre-check killed its process). Its `done`
    // has not fired yet — the teardown is still pending.
    const agentA = await startTurn("turn A");

    // Turn B starts and its env-prep writes the one-time failover notice.
    const agentB = await startTurn("turn B", { emitFailoverNotice: true });
    expect(
      chatHistory.load(SESSION).filter((m) => m.text === NOTICE && m.inProgress),
    ).toHaveLength(1);

    // Turn A's pending teardown now lands, INSIDE turn B's window. Unguarded,
    // its `onInterruptedTurn` finalizes turn B's in-progress rows — the notice
    // among them.
    agentA.emit("done", 143);
    await flushTurn();

    // Turn B completes normally; its final persist rebuilds from
    // `recordedCards`, which still hold the notice.
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

    // The stale exit's "Agent process exited with code 143" row belongs to no
    // turn the user can still see — it must not appear inside turn B.
    expect(chatHistory.load(SESSION).filter((m) => m.isError)).toHaveLength(0);
  });

  it("a stale adapter-level error does not finalize the successor's rows or clear its running flag", async () => {
    // The incident's likeliest deliverer: the killed resident's in-flight
    // worker HTTP call rejects and the proxy emits `error` LOCALLY — the SSE
    // relay's runToken guard never sees it.
    const agentA = await startTurn("turn A");
    const agentB = await startTurn("turn B", { emitFailoverNotice: true });
    expect(runner.running).toBe(true);

    agentA.emit("error", new Error("Worker request timed out after 10000ms: /agent/message"));
    await flushTurn();

    // The successor turn is untouched: still running, notice still in progress.
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

  it("still finalizes a genuinely interrupted turn's partial work (no successor)", async () => {
    // The docs/156 guarantee is unchanged: with NO newer turn, an abnormal
    // exit still flips the partial turn's rows to permanent.
    const agentA = await startTurn("turn A", { emitFailoverNotice: true });

    agentA.emit("done", 143);
    await flushTurn();

    // The notice was finalized (not wiped) and the no-result error row exists.
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
