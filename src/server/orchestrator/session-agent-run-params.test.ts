/**
 * Tests for `buildAgentRunParams` — specifically the runtime flags it derives
 * from the session row and hands to the per-agent prep hook
 * (`PrepareRunParamsInput`). The hook itself is covered by
 * `agent-run-params-prep.test.ts`; here we assert what the assembler *computes*,
 * using a capturing prep hook so the assertions don't depend on Claude's
 * particular field names.
 */

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

/**
 * Build deps around one session row, plus a prep hook that records the
 * `PrepareRunParamsInput` it was called with.
 */
function setup(session: SessionInfo | undefined) {
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
    getSelectedModel: () => undefined,
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
    // The anchor is dropped by a successful reset and by `clearMerged`, so the
    // guard disarms itself rather than sticking for the session's lifetime.
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
    // Belt-and-braces: the hook also self-gates off on SHIPIT_SANDBOX (docs/211).
    const { run, captured } = setup(makeSession({ kind: "sandbox" }));
    await run();
    expect(captured[0]?.guardDestructiveGitActive).toBe(false);
    expect(captured[0]?.sandboxActive).toBe(true);
  });
});
