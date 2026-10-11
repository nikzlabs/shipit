import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  forgetStatusCardSpawn,
  statusCardSpawnValue,
} from "./session-status-spawn-record.js";
import type { AgentId, McpServerConfig, SessionInfo } from "../shared/types.js";
import {
  forgetServiceMcpSpawn,
  serviceMcpSetKey,
  serviceMcpSpawnKey,
  type SessionServiceMcp,
} from "./service-mcp.js";
import {
  buildAgentRunParams,
  type BuildAgentRunParamsDeps,
} from "./session-agent-run-params.js";
import type {
  PrepareRunParamsFn,
  PrepareRunParamsInput,
} from "./agent-run-params-prep.js";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as SessionInfo;
}

function setup(
  session: SessionInfo | undefined,
  connectionModel?: string,
  connectionReasoning?: string,
  opts: {
    sessionStatusCard?: boolean;
    agentInstructions?: boolean;
    accountMcp?: Record<string, McpServerConfig>;
    serviceMcp?: SessionServiceMcp;
  } = {},
) {
  const captured: PrepareRunParamsInput[] = [];
  const prep: PrepareRunParamsFn = (params, input) => {
    captured.push(input);
    return params;
  };
  const deps = {
    credentialStore: {
      getAgentSystemInstructionsEnabled: () => opts.agentInstructions === true,
      getAllMcpServers: () => opts.accountMcp ?? {},
      getAutoCreatePr: () => true,
      getSessionStatusCard: () => opts.sessionStatusCard === true,
    },
    githubAuthManager: { authenticated: true },
    sessionManager: {
      consumeConversationReplay: () => undefined,
      get: () => session,
    },
    readSystemPrompt: async () => undefined,
    getSelectedModel: () => connectionModel,
    getSelectedReasoning: () => connectionReasoning,
    runParamsPreps: new Map<AgentId, PrepareRunParamsFn>([["claude", prep]]),
  } as unknown as BuildAgentRunParamsDeps;

  const run = () =>
    buildAgentRunParams({
      deps,
      sessionId: "s1",
      agentId: "claude" as AgentId,
      prompt: "hi",
      sessionDir: "/workspace",
      ...(opts.serviceMcp ? { serviceMcp: opts.serviceMcp } : {}),
    });

  return { run, captured };
}

describe("buildAgentRunParams — planning#267 destructive-git guard", () => {
  it("arms the guard when the session has a recorded mergedHeadSha", async () => {
    const { run, captured } = setup(
      makeSession({ mergedAt: new Date().toISOString(), mergedHeadSha: "abc123" }),
    );
    await run();
    expect(captured[0]?.guardDestructiveGitActive).toBe(true);
  });

  it("leaves the guard off for an ordinary (unmerged) session", async () => {
    const { run, captured } = setup(makeSession());
    await run();
    expect(captured[0]?.guardDestructiveGitActive).toBe(false);
  });

  it("leaves the guard off once mergedHeadSha is cleared (post-reset / clearMerged)", async () => {
    const { run, captured } = setup(makeSession({ mergedAt: new Date().toISOString() }));
    await run();
    expect(captured[0]?.guardDestructiveGitActive).toBe(false);
  });

  it("leaves the guard off when the session row is missing entirely", async () => {
    const { run, captured } = setup(undefined);
    await run();
    expect(captured[0]?.guardDestructiveGitActive).toBe(false);
  });

  it("a sandbox session carries no merged anchor, so the guard stays off", async () => {
    const { run, captured } = setup(makeSession({ kind: "sandbox" }));
    await run();
    expect(captured[0]?.guardDestructiveGitActive).toBe(false);
    expect(captured[0]?.sandboxActive).toBe(true);
  });
});

describe("buildAgentRunParams — the model comes from the session row", () => {
  it("prefers the row over a stale per-connection selection", async () => {
    const { run } = setup(
      makeSession({
        model: "anthropic/claude-opus-5",
        serviceId: "vercel",
        billingMode: "key",
      }),
      "claude-sonnet-5",
    );
    const params = await run();
    expect(params.model).toBe("anthropic/claude-opus-5");
  });

  it("falls back to the connection when the row holds no model yet", async () => {
    const { run } = setup(makeSession({}), "claude-sonnet-5");
    const params = await run();
    expect(params.model).toBe("claude-sonnet-5");
  });
});

describe("buildAgentRunParams — the reasoning level comes from the session row", () => {
  it("prefers the row over a stale per-connection selection", async () => {
    const { run } = setup(
      makeSession({ reasoningEffort: "high" }),
      undefined,
      "low",
    );
    const params = await run();
    expect(params.reasoningEffort).toBe("high");
  });

  it("falls back to the connection when the row holds no level yet", async () => {
    const { run } = setup(makeSession({}), undefined, "low");
    const params = await run();
    expect(params.reasoningEffort).toBe("low");
  });
});

const promptSection = (name: string): string =>
  fs.readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trim();

describe("buildAgentRunParams — docs/303 session status card", () => {
  it("records the value this spawn carries, for the resident-reuse check", async () => {
    forgetStatusCardSpawn("s1");
    const { run } = setup(makeSession(), undefined, undefined, { sessionStatusCard: true });
    await run();
    expect(statusCardSpawnValue("s1")).toBe(true);

    const off = setup(makeSession());
    await off.run();
    expect(statusCardSpawnValue("s1")).toBe(false);
    forgetStatusCardSpawn("s1");
  });

  it("carries the setting to the agent and picks the status-card prompt", async () => {
    const { run } = setup(makeSession(), undefined, undefined, {
      sessionStatusCard: true,
      agentInstructions: true,
    });
    const params = await run();
    expect(params.sessionStatusCard).toBe(true);
    expect(params.systemPrompt).toContain(promptSection("session-status.md"));
    expect(params.systemPrompt).not.toContain(promptSection("propose-actions.md"));
  });

  it("omits the flag and keeps the action-card prompt while the setting is off", async () => {
    const { run } = setup(makeSession(), undefined, undefined, { agentInstructions: true });
    const params = await run();
    expect(params.sessionStatusCard).toBeUndefined();
    expect(params.systemPrompt).toContain(promptSection("propose-actions.md"));
    expect(params.systemPrompt).not.toContain(promptSection("session-status.md"));
  });
});

describe("buildAgentRunParams — docs/327 MCP servers on Compose services", () => {
  const account = (name: string): McpServerConfig => ({ name, type: "http", url: `https://${name}.example/mcp`, enabled: true });
  const verseshot = { name: "verseshot", url: "http://verseshot:8787/mcp" };

  it("sends the session's declared servers and the names a plugin's server can still take", async () => {
    forgetServiceMcpSpawn("s1");
    const { run } = setup(makeSession(), undefined, undefined, {
      accountMcp: { linear: account("linear") },
      serviceMcp: { servers: [verseshot], candidates: ["verseshot", "requirements"] },
    });

    const params = await run();

    expect(params.serviceMcpServers).toEqual([verseshot]);
    expect(params.serviceMcpCandidates).toEqual(["verseshot", "requirements"]);
    expect(params.mcpServers?.map((s) => s.name)).toEqual(["linear"]);
    expect(serviceMcpSpawnKey("s1")).toBe(serviceMcpSetKey([verseshot]));
  });

  it("records an empty set for a session that declares none", async () => {
    const { run } = setup(makeSession());

    const params = await run();

    expect(params.serviceMcpServers).toBeUndefined();
    expect(serviceMcpSpawnKey("s1")).toBe(serviceMcpSetKey([]));
  });
});
