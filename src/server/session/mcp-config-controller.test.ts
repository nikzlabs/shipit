import { describe, it, expect, vi } from "vitest";
import { McpConfigController } from "./mcp-config-controller.js";
import type {
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentRunParams,
  McpServerConfig,
} from "./agents/agent-process.js";
import type { WorkerSSEEvent } from "./sse-broadcaster.js";

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

describe("McpConfigController.withServiceMcpServers (docs/327)", () => {
  const proxy = { tsxBin: "/usr/bin/node", bridgePath: "/app/dist/mcp-bridges/mcp-service-proxy.js" };
  const verseshot = { name: "verseshot", url: "http://verseshot:8787/mcp" };
  const base = { prompt: "p", cwd: "/workspace" } as AgentRunParams;

  function controllerWith(paths: typeof proxy | null) {
    const events: WorkerSSEEvent[] = [];
    const controller = new McpConfigController({ broadcast: (e) => events.push(e) });
    vi.spyOn(controller, "serviceProxyPaths").mockReturnValue(paths);
    return { controller, events };
  }

  it("adds each declared server as a stdio entry that runs the proxy with the service's URL", () => {
    const { controller } = controllerWith(proxy);
    const account: McpServerConfig = { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", enabled: true };

    const params = controller.withServiceMcpServers({ ...base, mcpServers: [account], serviceMcpServers: [verseshot] });

    expect(params.mcpServers).toEqual([
      account,
      {
        name: "verseshot",
        type: "stdio",
        command: proxy.tsxBin,
        args: [proxy.bridgePath, verseshot.url],
        enabled: true,
      },
    ]);
  });

  it("gives the name to the declared server when an account server has it too", () => {
    const { controller } = controllerWith(proxy);
    const account: McpServerConfig = { name: "Verseshot", type: "http", url: "https://example.com/mcp", enabled: true };

    const params = controller.withServiceMcpServers({ ...base, mcpServers: [account], serviceMcpServers: [verseshot] });

    expect(params.mcpServers?.map((s) => [s.name, s.type])).toEqual([["verseshot", "stdio"]]);
  });

  it("is what the adapter's writer receives, so every backend writes the entry", () => {
    const { controller } = controllerWith(proxy);
    const { agent, seen } = fakeAgent();

    controller.invokeAgentMcpWriter(agent, controller.withServiceMcpServers({ ...base, serviceMcpServers: [verseshot] }));

    expect(seen[0]?.servers.map((s) => s.name)).toEqual(["verseshot"]);
  });

  it("returns the params unchanged when nothing is declared", () => {
    const { controller } = controllerWith(proxy);
    expect(controller.withServiceMcpServers(base)).toBe(base);
  });

  it("reports each server as failed when the image has no proxy", () => {
    const { controller, events } = controllerWith(null);

    const params = controller.withServiceMcpServers({ ...base, serviceMcpServers: [verseshot] });

    expect(params.mcpServers).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({ type: "mcp_server_status", data: expect.objectContaining({ name: "verseshot", state: "failed" }) }),
    ]);
  });
});
