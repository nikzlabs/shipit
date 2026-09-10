import { describe, it, expect } from "vitest";
import type { AgentId, SessionInfo } from "../shared/types.js";
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
) {
  const captured: PrepareRunParamsInput[] = [];
  const prep: PrepareRunParamsFn = (params, input) => {
    captured.push(input);
    return params;
  };
  const deps = {
    credentialStore: {
      getAgentSystemInstructionsEnabled: () => false,
      getAllMcpServers: () => ({}),
      getAutoCreatePr: () => true,
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
