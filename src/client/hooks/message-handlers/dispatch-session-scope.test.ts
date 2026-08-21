import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { usePrStore } from "../../stores/pr-store.js";
import { dispatchMessage } from "./index.js";
import type { HandlerContext } from "./types.js";
import type { WsServerMessage } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const consultCard = (sessionId: string): WsServerMessage => ({
  type: "sub_agent_consult_card",
  sessionId,
  card: {
    cardId: `card-${sessionId}`,
    spawnId: `spawn-${sessionId}`,
    subAgentId: "codex",
    status: "success",
    durationMs: 4700,
    costUsd: 0.03,
    truncated: false,
    createdAt: "2026-07-25T00:00:00.000Z",
  },
});

beforeEach(() => {
  useSessionStore.getState().reset();
  useSessionStore.setState({ sessionId: "active", messages: [], subAgentSpawns: {} });
});

describe("dispatchMessage — transcript session scoping", () => {
  it("applies a sub-agent spinner + consult card for the ACTIVE session", () => {
    dispatchMessage(ctx, {
      type: "sub_agent_spawn",
      sessionId: "active",
      spawnId: "spawn-active",
      subAgentId: "codex",
    });
    expect(useSessionStore.getState().subAgentSpawns["spawn-active"]).toMatchObject({
      subAgentId: "codex",
    });

    dispatchMessage(ctx, consultCard("active"));
    expect(useSessionStore.getState().messages).toMatchObject([
      { role: "assistant", subAgentConsult: { cardId: "card-active" } },
    ]);
  });

  it("drops a sub-agent spinner spawned by a DIFFERENT session", () => {
    dispatchMessage(ctx, {
      type: "sub_agent_spawn",
      sessionId: "other",
      spawnId: "spawn-other",
      subAgentId: "codex",
    });
    expect(useSessionStore.getState().subAgentSpawns).toEqual({});
  });

  it("drops a consult card belonging to a DIFFERENT session", () => {
    dispatchMessage(ctx, consultCard("other"));
    expect(useSessionStore.getState().messages).toEqual([]);
  });

  it("drops other transcript cards belonging to a DIFFERENT session", () => {
    dispatchMessage(ctx, {
      type: "voice_note",
      sessionId: "other",
      id: "note-1",
      headline: "Done — want me to dig in?",
      kind: "authored",
      createdAt: "2026-07-25T00:00:00.000Z",
    });
    dispatchMessage(ctx, {
      type: "session_spawned",
      sessionId: "other",
      childSessionId: "child-1",
      title: "Fix the flaky test",
      spawnedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(useSessionStore.getState().messages).toEqual([]);
  });

  it("applies container freshness only to its owning active session", () => {
    const stale = {
      state: "stale" as const,
      workerBuildId: "old",
      orchestratorBuildId: "new",
    };
    dispatchMessage(ctx, {
      type: "session_container_freshness",
      sessionId: "other",
      freshness: stale,
    });
    expect(useSessionStore.getState().containerFreshness).toBeNull();

    dispatchMessage(ctx, {
      type: "session_container_freshness",
      sessionId: "active",
      freshness: stale,
    });
    expect(useSessionStore.getState().containerFreshness).toEqual(stale);
  });

  it("applies the secret-scan commit block only to its owning active session", () => {
    // planning#317 — the banner is session state, and the browser holds exactly one
    // session's view, so a foreign block must not raise it here.
    const block = {
      findings: [{ rule: "github-pat", description: "PAT", file: "a.ts", line: 1, redacted: "ghp_…" }],
      at: "2026-08-04T12:00:00.000Z",
      notifyCount: 1,
    };
    dispatchMessage(ctx, { type: "secret_block_status", sessionId: "other", block });
    expect(useSessionStore.getState().secretBlock).toBeNull();

    dispatchMessage(ctx, { type: "secret_block_status", sessionId: "active", block });
    expect(useSessionStore.getState().secretBlock).toEqual(block);
  });

  it("still delivers messages that legitimately describe OTHER sessions", () => {
    // Sidebar running dots are keyed by their own sessionId — never scoped out.
    dispatchMessage(ctx, { type: "session_status", sessionId: "other", running: true });
    expect(useSessionStore.getState().activeRunnerSessions.has("other")).toBe(true);

    dispatchMessage(ctx, { type: "reset_eligible", sessionId: "other", eligible: true });
    expect(usePrStore.getState().resetEligibleBySession.other).toBe(true);
  });

  it("does not drop when the store has no active session yet (bootstrap)", () => {
    useSessionStore.setState({ sessionId: undefined });
    dispatchMessage(ctx, consultCard("other"));
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
