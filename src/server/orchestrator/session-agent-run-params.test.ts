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

/**
 * docs/252 phase 4 — the model and the service shaping must come from ONE
 * source, and cross-backend review found they did not.
 *
 * `getSelectedModel` is per-CONNECTION on the user path, while the service,
 * billing mode and credential are read from the session row. With two viewers
 * on one session, a switch in tab A leaves tab B's closure holding the previous
 * model — so a turn sent from B spawned model X against service Y's endpoint,
 * and the resident process was then stamped with Y's identity even though it was
 * spawned with X, so a later switch back to X reused a process running the wrong
 * model.
 */
describe("buildAgentRunParams — the model comes from the session row", () => {
  it("prefers the row over a stale per-connection selection", async () => {
    const { run } = setup(
      makeSession({
        model: "anthropic/claude-opus-5",
        serviceId: "vercel",
        billingMode: "key",
      }),
      "claude-sonnet-5", // what the OTHER tab's connection still holds
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

/**
 * docs/217 — the reasoning level had the shape the model was fixed out of.
 *
 * `getSelectedReasoning` is per-CONNECTION, resolved once at connect for the
 * session the socket was opened on. A `send_message` carrying an explicit
 * `sessionId` retargets that socket without recomputing it, so the turn ran at
 * the other session's depth — the level being an argument to the CLI, not
 * something the row is consulted for. Found by cross-backend review (Codex).
 */
describe("buildAgentRunParams — the reasoning level comes from the session row", () => {
  it("prefers the row over a stale per-connection selection", async () => {
    const { run } = setup(
      makeSession({ reasoningEffort: "high" }),
      undefined,
      "low", // what the connection still holds for the session it was opened on
    );
    const params = await run();
    expect(params.reasoningEffort).toBe("high");
  });

  it("falls back to the connection when the row holds no level yet", async () => {
    // The connect param seeds an as-yet-unpinned session, so the fallback is
    // still load-bearing for the very first turn.
    const { run } = setup(makeSession({}), undefined, "low");
    const params = await run();
    expect(params.reasoningEffort).toBe("low");
  });
});
