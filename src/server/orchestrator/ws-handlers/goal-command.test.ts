import { describe, it, expect, vi } from "vitest";
import { handleGoalCommand } from "./goal-command.js";
import type { AgentCapabilities, AgentGoalCommand } from "../../shared/types/agent-types.js";

function makeCtx(goalActions?: AgentCapabilities["goalActions"]) {
  const notices: { message: string; level?: string }[] = [];
  const goalCalls: AgentGoalCommand[] = [];
  const ctx = {
    getActiveAgentId: () => "grok",
    getActiveAppSessionId: () => "s1",
    getRunnerRegistry: () => ({ get: () => null }),
    getRunner: () => null,
    send: (msg: { type: string; message?: string; level?: string }) => {
      if (msg.type === "system_notice") notices.push({ message: msg.message ?? "", level: msg.level });
    },
    chatHistoryManager: { append: vi.fn() },
    sessionManager: {
      get: () => ({ agentSessionId: "thread-1" }),
      setAgentGoal: () => false,
    },
    sseBroadcast: vi.fn(),
    agentRegistry: { get: () => ({ capabilities: { goalActions } }) },
    agentFactory: () => ({
      agentId: "grok",
      goalCommand: (_threadId: string, command: AgentGoalCommand) => {
        goalCalls.push(command);
        return Promise.resolve({ goal: null });
      },
    }),
  };
  return { ctx: ctx as never, notices, goalCalls };
}

describe("handleGoalCommand — per-action modes (docs/298)", () => {
  it("refuses an action the harness does not declare, without reaching the CLI", async () => {
    const { ctx, notices, goalCalls } = makeCtx({ get: "control", set: "turn" });
    await handleGoalCommand(ctx, { action: "pause" }, "s1");
    expect(goalCalls).toEqual([]);
    expect(notices).toEqual([{
      message: "grok has no goal pause. Use `/goal clear` to remove the goal.",
      level: "warn",
    }]);
  });

  it("runs an action the harness declares as control", async () => {
    const { ctx, goalCalls } = makeCtx({ get: "control", set: "turn" });
    await handleGoalCommand(ctx, { action: "get" }, "s1");
    expect(goalCalls).toEqual([{ action: "get" }]);
  });

  // Codex declares no map, so every action stays interceptable exactly as docs/154 shipped it.
  it("runs every action when the harness declares no map", async () => {
    for (const command of [{ action: "get" }, { action: "pause" }, { action: "clear" }] as const) {
      const { ctx, goalCalls } = makeCtx(undefined);
      await handleGoalCommand(ctx, command, "s1");
      expect(goalCalls).toEqual([command]);
    }
  });
});
