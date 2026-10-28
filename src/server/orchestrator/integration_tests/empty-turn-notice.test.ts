import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId, LastTurnOutcome } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import type { EmptyTurnReason } from "../turn-settlement.js";
import { testDispatch } from "./dispatch-test-helpers.js";

/** planning#222 — a successful turn that left no reply and no tool call is told and recorded. */

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
}

function setup(opts: { inboxDelivered?: () => void; prompt?: string } = {}) {
  const agents: FakeAgent[] = [];
  const appended: PersistedMessage[] = [];
  const ends: { outcome: LastTurnOutcome; emptyReason: EmptyTurnReason | null }[] = [];
  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const agent = new EventEmitter() as FakeAgent;
      agent.run = vi.fn();
      agent.kill = vi.fn();
      agent.interrupt = vi.fn();
      agents.push(agent);
      return agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
    autoCommit: vi.fn().mockResolvedValue({
      commitHash: null,
      parentHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [],
    }),
    scheduleAutoPush: vi.fn(),
    prepareAgentEnv: vi.fn().mockResolvedValue(undefined),
    ...(opts.inboxDelivered
      ? { inboxNotice: () => ({ notice: "[ShipIt] 1 unread message waits.", delivered: opts.inboxDelivered! }) }
      : {}),
    listenerDeps: {
      sessionManager: {
        setAgentSessionId: vi.fn(),
        setLastTurnErrored: vi.fn(),
        setLastTurnOutcome: (_id: string, outcome: LastTurnOutcome, emptyReason: EmptyTurnReason | null) => {
          ends.push({ outcome, emptyReason });
        },
        get: vi.fn(),
        track: vi.fn(),
        touchUnlessResolved: vi.fn(),
        setMuted: vi.fn(),
        list: vi.fn().mockReturnValue([]),
      } as never,
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        finalizeInProgress: vi.fn(),
        append: (_id: string, message: PersistedMessage) => {
          appended.push(message);
          return appended.length;
        },
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
      sseBroadcast: vi.fn(),
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn().mockResolvedValue({ prompt: opts.prompt ?? "do work", cwd: "/tmp/s1" }),
  };
  const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
  runner.setSystemTurnDeps(deps);
  const notices = () => appended.filter((m) => m.notice).map((m) => m.text);
  const userRows = () => appended.filter((m) => m.role === "user");
  return { runner, agents, ends, notices, userRows };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function nextAgent(agents: FakeAgent[], count: number): Promise<FakeAgent> {
  await waitFor(() => agents.length === count && agents[count - 1]!.run.mock.calls.length === 1, `agent ${count} run`);
  return agents[count - 1]!;
}

const echo = (agent: FakeAgent): void => {
  agent.emit("event", { type: "agent_user_replay", text: "do work" });
};

const result = (agent: FakeAgent, extra: Record<string, unknown> = {}): void => {
  agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid", ...extra });
  agent.emit("done", 0);
};

describe("a turn that ends with no reply and no tool call (planning#222)", () => {
  it("tells the user and records that the model returned nothing", async () => {
    const { runner, agents, ends, notices } = setup();
    runner.dispatch(testDispatch({ text: "do work" }));
    const agent = await nextAgent(agents, 1);
    echo(agent);
    result(agent, { numTurns: 1 });
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(notices()).toEqual([expect.stringContaining("The model ended this turn with no reply and no tool call")]);
    expect(ends).toEqual([{ outcome: "ok", emptyReason: "model-returned-nothing" }]);
    expect(agents).toHaveLength(1);
    runner.dispose({ force: true });
  });

  it("tells the user and records that the CLI made no model call", async () => {
    const { runner, agents, ends, notices } = setup();
    runner.dispatch(testDispatch({ text: "do work" }));
    const agent = await nextAgent(agents, 1);
    echo(agent);
    result(agent, { numTurns: 0 });
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(notices()).toEqual([expect.stringContaining("without a call to the model")]);
    expect(ends).toEqual([{ outcome: "ok", emptyReason: "no-model-call" }]);
    runner.dispose({ force: true });
  });

  it("sends a prompt that the CLI never read again, one time, on a new process", async () => {
    const { runner, agents, ends, notices, userRows } = setup();
    runner.dispatch(testDispatch({ text: "do work" }));
    const first = await nextAgent(agents, 1);
    // The stale-notice shape: a zero-turn result that answered a task notification.
    result(first, { numTurns: 0, origin: "task-notification" });

    const second = await nextAgent(agents, 2);
    expect(first.kill).toHaveBeenCalled();
    expect(notices()).toEqual([expect.stringContaining("ShipIt is sending the message again")]);

    echo(second);
    second.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Done." }] });
    result(second, { numTurns: 1 });
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(ends).toEqual([{ outcome: "ok", emptyReason: null }]);
    expect(notices()).toHaveLength(1);
    expect(userRows()).toHaveLength(1);
    expect(agents).toHaveLength(2);
    runner.dispose({ force: true });
  });

  it("does not send it a third time, and says so, when the new process does not read it either", async () => {
    const delivered = vi.fn();
    const { runner, agents, ends, notices } = setup({ inboxDelivered: delivered });
    runner.dispatch(testDispatch({ text: "do work" }));
    result(await nextAgent(agents, 1), { numTurns: 0 });
    result(await nextAgent(agents, 2), { numTurns: 0 });
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(agents).toHaveLength(2);
    expect(notices()).toEqual([
      expect.stringContaining("ShipIt is sending the message again"),
      expect.stringContaining("before it read the message, so there is no reply"),
    ]);
    expect(ends).toEqual([{ outcome: "ok", emptyReason: "prompt-not-echoed" }]);
    // A notice that rode a prompt the CLI never read was not delivered.
    expect(delivered).not.toHaveBeenCalled();
    runner.dispose({ force: true });
  });

  it("acknowledges the notices of a prompt that the CLI read, also when the turn ends empty", async () => {
    const delivered = vi.fn();
    const { runner, agents, ends } = setup({ inboxDelivered: delivered });
    runner.dispatch(testDispatch({ text: "do work" }));
    const agent = await nextAgent(agents, 1);
    echo(agent);
    result(agent, { numTurns: 1 });
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(delivered).toHaveBeenCalledTimes(1);
    runner.dispose({ force: true });
  });

  it("does not stop a process that runs background work to send the prompt again", async () => {
    const { runner, agents, ends, notices } = setup();
    vi.spyOn(runner, "backgroundWorkDescriptions", "get").mockReturnValue(["npm run build"]);
    runner.dispatch(testDispatch({ text: "do work" }));
    const agent = await nextAgent(agents, 1);
    result(agent, { numTurns: 0 });
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(agents).toHaveLength(1);
    expect(agent.kill).not.toHaveBeenCalled();
    expect(notices()).toEqual([expect.stringContaining("before it read the message, so there is no reply")]);
    expect(ends).toEqual([{ outcome: "ok", emptyReason: "prompt-not-echoed" }]);
    runner.dispose({ force: true });
  });

  it("records a stopped turn without a notice", async () => {
    const { runner, agents, ends, notices } = setup();
    runner.dispatch(testDispatch({ text: "do work" }));
    const agent = await nextAgent(agents, 1);
    echo(agent);
    runner.wasInterrupted = true;
    result(agent, { numTurns: 1 });
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(notices()).toEqual([]);
    expect(ends).toEqual([{ outcome: "ok", emptyReason: "stopped" }]);
    runner.dispose({ force: true });
  });

  it("says nothing about a slash command that the CLI answered by itself", async () => {
    const { runner, agents, ends, notices } = setup({ prompt: "/cost" });
    runner.dispatch(testDispatch({ text: "/cost" }));
    // No echo: the CLI need not echo a command it answers by itself.
    result(await nextAgent(agents, 1), { numTurns: 0 });
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(agents).toHaveLength(1);
    expect(notices()).toEqual([]);
    runner.dispose({ force: true });
  });

  it("records nothing for a turn that replied", async () => {
    const { runner, agents, ends, notices } = setup();
    runner.dispatch(testDispatch({ text: "do work" }));
    const agent = await nextAgent(agents, 1);
    echo(agent);
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Done." }] });
    result(agent, { numTurns: 1 });
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(notices()).toEqual([]);
    expect(ends).toEqual([{ outcome: "ok", emptyReason: null }]);
    runner.dispose({ force: true });
  });

  it("judges nothing when the harness does not report the turn's model calls", async () => {
    const { runner, agents, ends, notices } = setup();
    runner.dispatch(testDispatch({ text: "do work" }));
    result(await nextAgent(agents, 1));
    await waitFor(() => !runner.running && ends.length > 0, "turn end");

    expect(agents).toHaveLength(1);
    expect(notices()).toEqual([]);
    expect(ends).toEqual([{ outcome: "ok", emptyReason: null }]);
    runner.dispose({ force: true });
  });
});
