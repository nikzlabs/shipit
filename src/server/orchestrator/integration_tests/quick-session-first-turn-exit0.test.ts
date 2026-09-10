import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "../session-runner.js";
import type { AgentId } from "../../shared/types.js";
import {
  testDispatch,
  makeDispatchTurnDeps as makeDeps,
  flushTurn as flush,
  waitForTurn as waitFor,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

describe("quick-session first-turn exit-0 (docs/163)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("auto-retries once when the first dispatched turn exits with no result", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const appended: unknown[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const { deps } = makeDeps(agents, appended);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));

    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("done", 0);

    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    expect(messages.some((m) => m.type === "system_notice" && /retry/i.test(String(m.message)))).toBe(true);

    runner.dispose({ force: true });
  });

  it("surfaces a visible error (not a silent completed turn) when the retry also produces no result", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const appended: { role?: string; isError?: boolean; text?: string }[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const { deps, sseBroadcast } = makeDeps(agents, appended as unknown[]);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("done", 0);
    await waitFor(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    agents[1]!.emit("done", 0);

    await waitFor(
      () => appended.some((m) => m.role === "assistant" && m.isError === true),
      "error chat row",
    );
    expect(messages.some((m) => m.type === "error")).toBe(true);
    expect(sseBroadcast).toHaveBeenCalledWith("session_agent_finished", { sessionId: "s1" });
    expect(runner.running).toBe(false);
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  it("preserves partial work and does NOT retry when a turn streams content then exits with no result (OOM/SIGHUP)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const appended: { role?: string; isError?: boolean; text?: string }[] = [];
    const messages: { type: string; [k: string]: unknown }[] = [];
    runner.on("message", (m) => messages.push(m as never));
    const { deps } = makeDeps(agents, appended as unknown[]);
    runner.setSystemTurnDeps(deps);
    const histMgr = deps.listenerDeps.chatHistoryManager as unknown as {
      replaceInProgress: ReturnType<typeof vi.fn>;
      finalizeInProgress: ReturnType<typeof vi.fn>;
    };

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "The batch got OOM-killed (exit 137). Let me run smaller batches." }],
      sessionId: "agent-sid",
    });
    agents[0]!.emit("done", 129);

    await waitFor(
      () => appended.some((m) => m.role === "assistant" && m.isError === true),
      "error chat row",
    );

    expect(agents).toHaveLength(1);
    expect(messages.some((m) => m.type === "system_notice" && /retry/i.test(String(m.message)))).toBe(false);

    const lastReplace = histMgr.replaceInProgress.mock.calls.at(-1);
    const persistedMessages = (lastReplace?.[1] ?? []) as { role?: string; text?: string }[];
    expect(persistedMessages.length).toBeGreaterThan(0);
    expect(persistedMessages.some((m) => m.text?.includes("OOM-killed"))).toBe(true);
    expect(histMgr.finalizeInProgress).toHaveBeenCalledWith("s1");

    const errorMsg = messages.find((m) => m.type === "error");
    expect(String(errorMsg?.message)).toMatch(/preserved/i);

    runner.dispose({ force: true });
  });

  it("does NOT retry when the first turn completes normally (agent_result before done)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const appended: { role?: string; isError?: boolean }[] = [];
    const { deps, sseBroadcast } = makeDeps(agents, appended as unknown[]);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);

    await waitFor(() => sseBroadcast.mock.calls.some((c) => c[0] === "session_agent_finished"), "finished");

    expect(agents).toHaveLength(1);
    expect(appended.some((m) => m.isError === true)).toBe(false);
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });

  it("does NOT retry an auth-blocked turn (auth_required ends the turn legitimately)", async () => {
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    const agents: FakeAgent[] = [];
    const appended: unknown[] = [];
    const { deps } = makeDeps(agents, appended);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");

    agents[0]!.emit("auth_required");
    agents[0]!.emit("done", 0);

    await flush();
    await flush();
    expect(agents).toHaveLength(1);
    expect(runner.running).toBe(false);

    runner.dispose({ force: true });
  });
});
