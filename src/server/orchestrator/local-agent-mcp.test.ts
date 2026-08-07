/**
 * planning#300 — local-mode MCP at the spawn.
 *
 * The bug this covers is a code path that never ran, so the assertions are
 * about *sequencing and visibility*: the MCP env has to be live in `process.env`
 * both when the adapter resolves `$secret:` placeholders and when it spawns the
 * CLI (the MCP children inherit it), and gone again afterwards.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentProcess, AgentRunParams } from "../shared/types/agent-types.js";
import type {
  AgentMcpWriteContext,
  AgentMcpWriteResult,
} from "../shared/types/agent-types.js";
import type { McpServerConfig } from "../shared/types/mcp-types.js";
import { applyLocalMcp, localMcpSpawnEnv, LOCAL_SHIPIT_BRIDGE } from "./local-agent-mcp.js";

/** Minimal `CredentialStore` stub — only the two readers the env payload uses. */
function credentialStore(
  agentEnv: Record<string, string> = {},
  mcpOAuth: Record<string, { accessToken: string }> = {},
) {
  return {
    getAllAgentEnv: () => ({ ...agentEnv }),
    getAllMcpOAuthTokens: () => mcpOAuth as never,
  };
}

/** Records what the adapter saw, and the env visible at each step. */
interface FakeAgent extends AgentProcess {
  writeCtx: AgentMcpWriteContext | null;
  runParams: AgentRunParams | null;
  envAtWrite: Record<string, string | undefined>;
  envAtRun: Record<string, string | undefined>;
}

function fakeAgent(
  result: AgentMcpWriteResult | (() => AgentMcpWriteResult) = {},
  watchKeys: string[] = [],
): FakeAgent {
  const snapshot = () =>
    Object.fromEntries(watchKeys.map((k) => [k, process.env[k]]));
  const agent = new EventEmitter() as unknown as FakeAgent;
  agent.writeCtx = null;
  agent.runParams = null;
  agent.envAtWrite = {};
  agent.envAtRun = {};
  agent.writeMcpConfig = (ctx: AgentMcpWriteContext): AgentMcpWriteResult => {
    agent.writeCtx = ctx;
    agent.envAtWrite = snapshot();
    return typeof result === "function" ? result() : result;
  };
  agent.run = (params: AgentRunParams): void => {
    agent.runParams = params;
    agent.envAtRun = snapshot();
  };
  return agent;
}

const baseParams: AgentRunParams = { prompt: "hi", cwd: "/tmp/s1" };

describe("localMcpSpawnEnv", () => {
  it("is the compose-less worker push payload: agent env + MCP OAuth tokens", () => {
    const env = localMcpSpawnEnv(
      credentialStore(
        { mcp__linear__TOKEN: "sk-1", GITHUB_TOKEN: "gh-1" },
        { notion_oauth: { accessToken: "at-1" } },
      ),
    );
    // `mcp__*` values are what `$secret:` resolves against; `MCP_PLATFORM_*` is
    // what `$platform:<source>` resolves against. Plain agent-env entries come
    // along because a user server may reference one by name.
    expect(env).toEqual({
      mcp__linear__TOKEN: "sk-1",
      GITHUB_TOKEN: "gh-1",
      MCP_PLATFORM_NOTION_OAUTH: "at-1",
    });
  });
});

describe("applyLocalMcp", () => {
  it("writes the MCP config before the spawn and threads the path into run", () => {
    const agent = fakeAgent({ mcpConfigPath: "/tmp/mcp-config-1.json" });
    const servers: McpServerConfig[] = [
      { name: "linear", type: "http", url: "https://x", enabled: true } as McpServerConfig,
    ];
    applyLocalMcp(agent, { credentialStore: credentialStore() });

    agent.run({ ...baseParams, mcpServers: servers });

    expect(agent.writeCtx?.servers).toEqual(servers);
    expect(agent.runParams?.mcpConfigPath).toBe("/tmp/mcp-config-1.json");
  });

  it("gives a local spawn no `shipit` bridge — its tools are worker transports", () => {
    // Not a config preference: every tool on the bridge POSTs to the worker's
    // /agent-ops surface, and local mode has no worker. See LOCAL_SHIPIT_BRIDGE.
    const agent = fakeAgent();
    applyLocalMcp(agent, { credentialStore: credentialStore() });
    agent.run(baseParams);
    expect(agent.writeCtx?.shipitBridge).toBeNull();
    expect(LOCAL_SHIPIT_BRIDGE).toBeNull();
  });

  it("makes the MCP env visible to the placeholder resolution AND to the spawn", () => {
    const agent = fakeAgent({}, ["mcp__linear__TOKEN", "MCP_PLATFORM_NOTION_OAUTH"]);
    applyLocalMcp(agent, {
      credentialStore: credentialStore(
        { mcp__linear__TOKEN: "sk-1" },
        { notion_oauth: { accessToken: "at-1" } },
      ),
    });

    agent.run(baseParams);

    // `writeMcpConfig` substitutes `$secret:` against process.env…
    expect(agent.envAtWrite.mcp__linear__TOKEN).toBe("sk-1");
    // …and the CLI's MCP child processes inherit the spawn env.
    expect(agent.envAtRun.mcp__linear__TOKEN).toBe("sk-1");
    expect(agent.envAtRun.MCP_PLATFORM_NOTION_OAUTH).toBe("at-1");
  });

  it("restores process.env after the spawn", () => {
    process.env.LOCAL_MCP_PREEXISTING = "keep-me";
    try {
      const agent = fakeAgent();
      applyLocalMcp(agent, {
        credentialStore: credentialStore({
          mcp__linear__TOKEN: "sk-1",
          LOCAL_MCP_PREEXISTING: "temporary",
        }),
      });

      agent.run(baseParams);

      // A key we introduced is removed; one that already existed keeps its
      // original value rather than being deleted.
      expect(process.env.mcp__linear__TOKEN).toBeUndefined();
      expect(process.env.LOCAL_MCP_PREEXISTING).toBe("keep-me");
    } finally {
      delete process.env.LOCAL_MCP_PREEXISTING;
    }
  });

  it("applies `runtimeEnv` for the spawn only (Codex env indirection)", () => {
    const agent = fakeAgent(
      { runtimeEnv: { SHIPIT_MCP_TOOLS: "present", PLAYWRIGHT_BROWSERS_PATH: "/opt/pb" } },
      ["SHIPIT_MCP_TOOLS", "PLAYWRIGHT_BROWSERS_PATH"],
    );
    applyLocalMcp(agent, { credentialStore: credentialStore() });

    agent.run(baseParams);

    expect(agent.envAtRun.SHIPIT_MCP_TOOLS).toBe("present");
    expect(agent.envAtRun.PLAYWRIGHT_BROWSERS_PATH).toBe("/opt/pb");
    expect(process.env.SHIPIT_MCP_TOOLS).toBeUndefined();
  });

  it("registers the config cleanup on the process's `done` event", () => {
    const cleanup = vi.fn();
    const agent = fakeAgent({ mcpConfigPath: "/tmp/c.json", cleanup });
    applyLocalMcp(agent, { credentialStore: credentialStore() });

    agent.run(baseParams);
    expect(cleanup).not.toHaveBeenCalled();

    agent.emit("done", 0);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("forwards a dropped server to the failure reporter", () => {
    const onServerFailed = vi.fn();
    const agent = fakeAgent();
    agent.writeMcpConfig = (ctx: AgentMcpWriteContext): AgentMcpWriteResult => {
      ctx.onServerFailed("linear", "missing secret: mcp__linear__TOKEN");
      return {};
    };
    applyLocalMcp(agent, { credentialStore: credentialStore(), onServerFailed });

    agent.run(baseParams);

    expect(onServerFailed).toHaveBeenCalledWith("linear", "missing secret: mcp__linear__TOKEN");
  });

  it("still spawns — without MCP — when the config write throws", () => {
    // Fault-tolerant on purpose: a dogfood session that can't write its MCP
    // config should lose MCP, not lose the ability to run a turn at all.
    const agent = fakeAgent();
    agent.writeMcpConfig = () => {
      throw new Error("EACCES: /tmp");
    };
    applyLocalMcp(agent, { credentialStore: credentialStore() });

    agent.run(baseParams);

    expect(agent.runParams?.prompt).toBe("hi");
    expect(agent.runParams?.mcpConfigPath).toBeUndefined();
  });

  it("preserves every other run param", () => {
    const agent = fakeAgent({ mcpConfigPath: "/tmp/c.json" });
    applyLocalMcp(agent, { credentialStore: credentialStore() });

    agent.run({ ...baseParams, sessionId: "resume-me", model: "opus", useStreaming: true });

    expect(agent.runParams).toMatchObject({
      prompt: "hi",
      cwd: "/tmp/s1",
      sessionId: "resume-me",
      model: "opus",
      useStreaming: true,
      mcpConfigPath: "/tmp/c.json",
    });
  });
});
