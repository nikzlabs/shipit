import { describe, it, expect } from "vitest";
import { REPLAY_INLINE_BUDGET_BYTES } from "./services/replay.js";
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
    agentSessionId?: string;
    compact?: boolean;
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
      ...(opts.agentSessionId ? { agentSessionId: opts.agentSessionId } : {}),
      ...(opts.compact ? { compact: true } : {}),
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

describe("buildAgentRunParams — a replay only starts a conversation (docs/007)", () => {
  const replay = "You are continuing a conversation.\nUser: add the billing routes\nAssistant: done";

  it("resumes a stored id and never lets a stored replay displace it", async () => {
    const { run } = setup(makeSession({ conversationReplay: replay }), undefined, undefined, {
      agentSessionId: "stored-conversation",
    });

    const params = await run();

    expect(params.sessionId).toBe("stored-conversation");
    expect(params.prompt).toBe("hi");
    expect(params.systemPrompt ?? "").not.toContain("add the billing routes");
  });

  it("carries the replay on every spawn until the CLI reports a conversation", async () => {
    // The fake has no way to write the row, so a build that took the replay would throw.
    const { run } = setup(makeSession({ conversationReplay: replay }));

    const first = await run();
    const second = await run();

    expect(first.sessionId).toBeUndefined();
    expect(first.prompt).toContain("add the billing routes");
    expect(second.prompt).toContain("add the billing routes");
  });

  // req 8 — the CLI stores the first user message; it does not store a system prompt.
  it("puts the replay in front of the first prompt, not in the system prompt", async () => {
    const { run } = setup(makeSession({ conversationReplay: replay }), undefined, undefined, { agentInstructions: true });

    const params = await run();

    expect(params.prompt).toBe(`${replay}\n\nhi`);
    expect(params.systemPrompt).toBeDefined();
    expect(params.systemPrompt).not.toContain("add the billing routes");
  });

  it("starts the conversation with the replay alone when a compaction comes first: there is nothing to compact", async () => {
    const { run } = setup(makeSession({ conversationReplay: replay }), undefined, undefined, { compact: true });

    const params = await run();

    expect(params.prompt).toBe(replay);
    expect(params).not.toHaveProperty("compact");
  });

  it("compacts a stored conversation as asked", async () => {
    const { run } = setup(makeSession({ conversationReplay: replay }), undefined, undefined, {
      compact: true,
      agentSessionId: "stored-conversation",
    });

    const params = await run();

    expect(params).toMatchObject({ prompt: "hi", compact: true, sessionId: "stored-conversation" });
  });

  it("bounds a stored replay too large for the spawn request", async () => {
    const huge = Array.from({ length: 20_000 }, (_, i) => `User: message ${i} ${"x".repeat(40)}`).join("\n");
    const { run } = setup(makeSession({ conversationReplay: huge }));

    const params = await run();

    const sent = params.prompt.slice(0, -"\n\nhi".length);
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(REPLAY_INLINE_BUDGET_BYTES);
    expect(params.prompt).toContain("message 19999 ");
  });
});

describe("buildAgentRunParams — a rewind point (docs/007 req 4)", () => {
  it("forks the stored conversation at the point", async () => {
    const { run } = setup(makeSession({ agentResumeAt: "msg-7" }), undefined, undefined, {
      agentSessionId: "stored-conversation",
    });

    const params = await run();

    expect(params).toMatchObject({ sessionId: "stored-conversation", resumeAt: "msg-7" });
  });

  it("names no point without a stored conversation to fork", async () => {
    const { run } = setup(makeSession({ agentResumeAt: "msg-7" }));

    const params = await run();

    expect(params.sessionId).toBeUndefined();
    expect(params).not.toHaveProperty("resumeAt");
  });
});
