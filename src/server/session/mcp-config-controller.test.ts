import { describe, it, expect } from "vitest";
import { McpConfigController } from "./mcp-config-controller.js";
import type {
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentRunParams,
} from "./agents/agent-process.js";

function fakeAgent(): { agent: AgentProcess; seen: AgentMcpWriteContext[] } {
  const seen: AgentMcpWriteContext[] = [];
  const agent = {
    writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
      seen.push(ctx);
      return {};
    },
  } as unknown as AgentProcess;
  return { agent, seen };
}

describe("McpConfigController.invokeAgentMcpWriter", () => {
  const controller = new McpConfigController({ broadcast: () => undefined });

  it("docs/303 req 21 — passes the turn's session-status flag to the adapter", () => {
    const { agent, seen } = fakeAgent();
    controller.invokeAgentMcpWriter(agent, {
      prompt: "p",
      cwd: "/workspace",
      sessionStatusCard: true,
    } as AgentRunParams);
    expect(seen[0]?.sessionStatusCard).toBe(true);
  });

  it("passes false when the turn carries no flag, and with no params at all", () => {
    const withParams = fakeAgent();
    controller.invokeAgentMcpWriter(withParams.agent, { prompt: "p", cwd: "/w" } as AgentRunParams);
    expect(withParams.seen[0]?.sessionStatusCard).toBe(false);

    const without = fakeAgent();
    controller.invokeAgentMcpWriter(without.agent);
    expect(without.seen[0]?.sessionStatusCard).toBe(false);
  });
});
