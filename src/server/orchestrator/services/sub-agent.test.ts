/**
 * Unit tests for the sub-agent spawn service (docs/144). Exercises the
 * authorization gates (setting, auth, pin, recursion, per-turn cap), the happy
 * path (spawn → usage attribution → chips), and the sign-out credential sweep,
 * using lightweight stubs so no container/worker is involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSubAgent, sweepSubAgentCredentialsOnSignOut, SUB_AGENT_PER_TURN_CAP } from "./sub-agent.js";
import { ServiceError } from "./types.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import {
  perSessionCredentialsDir,
  provisionSubAgentCredentials,
} from "../session-credentials.js";

interface FakeSession {
  id: string;
  agentId?: string;
  agentPinned?: boolean;
}

function makeDeps(opts: {
  enableSubAgents?: boolean;
  session?: FakeSession | null;
  sessions?: FakeSession[];
  authConfigured?: boolean;
  agentKnown?: boolean;
  subAgentSpawnsThisTurn?: number;
  spawnResult?: SubAgentRunResult;
  runnerPresent?: boolean;
}) {
  const session: FakeSession | null =
    opts.session === undefined ? { id: "s1", agentId: "claude", agentPinned: true } : opts.session;
  const emitMessage = vi.fn();
  const record = vi.fn();
  const getSessionUsage = vi.fn(() => ({
    sessionId: "s1",
    totalCostUsd: 0.03,
    totalDurationMs: 4200,
    turnCount: 1,
  }));
  const getSessionTokenTotals = vi.fn(() => ({
    cumulativeInputTokens: 1000,
    cumulativeOutputTokens: 200,
  }));
  const recordAgentRateLimits = vi.fn();
  const replaceInProgress = vi.fn();
  // emitChatCard reads chatMessageGroups/steeredMessages and mutates recordedCards,
  // then persists via chatHistoryManager.replaceInProgress — stub all four.
  const runner = {
    subAgentSpawnsThisTurn: opts.subAgentSpawnsThisTurn ?? 0,
    emitMessage,
    chatMessageGroups: [] as never[],
    steeredMessages: [] as never[],
    recordedCards: [] as never[],
    spawnSubAgent: vi.fn(async () =>
      opts.spawnResult ?? {
        status: "success",
        text: "2 bugs found",
        truncated: false,
        durationMs: 4200,
        costUsd: 0.03,
        inputTokens: 1000,
        outputTokens: 200,
        contextTokens: 1200,
      },
    ),
  };
  const deps = {
    sessionManager: {
      get: vi.fn((id: string) => (session?.id === id ? session : undefined)),
      list: vi.fn(() => opts.sessions ?? []),
    } as never,
    credentialStore: {
      getEnableSubAgents: () => opts.enableSubAgents ?? true,
      getAgentSubAgentDefaults: () => ({}),
    } as never,
    agentRegistry: {
      refreshAuth: vi.fn(),
      get: vi.fn(() => (opts.agentKnown === false ? undefined : { name: "Codex", authConfigured: opts.authConfigured ?? true })),
    } as never,
    runnerRegistry: { get: vi.fn(() => (opts.runnerPresent === false ? undefined : runner)) } as never,
    usageManager: { record, getSessionUsage, getSessionTokenTotals } as never,
    recordAgentRateLimits,
    chatHistoryManager: { replaceInProgress } as never,
  };
  return { deps, runner, emitMessage, record, replaceInProgress, recordAgentRateLimits };
}

async function expectServiceError(p: Promise<unknown>, status: number): Promise<ServiceError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).statusCode).toBe(status);
    return err as ServiceError;
  }
  throw new Error(`expected a ServiceError ${status}, but none was thrown`);
}

describe("runSubAgent — authorization gates", () => {
  it("rejects when the setting is off (403) and never spawns", async () => {
    const { deps, runner } = makeDeps({ enableSubAgents: false });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 403);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects an unknown agent (400)", async () => {
    const { deps } = makeDeps({ agentKnown: false });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 400);
  });

  it("rejects an unauthed agent (400)", async () => {
    const { deps } = makeDeps({ authConfigured: false });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 400);
  });

  it("rejects a pre-pin session (409)", async () => {
    const { deps } = makeDeps({ session: { id: "s1", agentId: "claude", agentPinned: false } });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 409);
  });

  it("rejects a non-zero depth — recursion guard (403)", async () => {
    const { deps, runner } = makeDeps({});
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 1 }), 403);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects past the per-turn cap (429) without spawning", async () => {
    const { deps, runner } = makeDeps({ subAgentSpawnsThisTurn: SUB_AGENT_PER_TURN_CAP });
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 429);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt (400)", async () => {
    const { deps } = makeDeps({});
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "   ", depth: 0 }), 400);
  });
});

describe("runSubAgent — happy path", () => {
  it("spawns, returns text, increments the per-turn counter, records usage, emits spinner + persisted consult card", async () => {
    const { deps, runner, emitMessage, record, replaceInProgress } = makeDeps({});
    const res = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review this", depth: 0 });

    expect(res.text).toBe("2 bugs found");
    expect(res.subAgentId).toBe("codex");
    expect(runner.subAgentSpawnsThisTurn).toBe(1);
    expect(runner.spawnSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "codex", prompt: "review this", depth: 0 }),
    );
    // usage attributed to the sub-agent, not the pinned agent — now WITH the
    // sub-agent's token breakdown (docs/144), not undefined/undefined.
    expect(record).toHaveBeenCalledWith("s1", 0.03, 4200, 1000, 200, {
      subAgentId: "codex",
      contextTokens: 1200,
    });
    // transient running spinner, then the live bill refresh, then the terminal
    // persisted consult card.
    const msgs = emitMessage.mock.calls.map((c) => c[0] as { type: string });
    expect(msgs[0]).toMatchObject({ type: "sub_agent_spawn", subAgentId: "codex" });
    // the bill update is flagged subAgent so it doesn't move the context dial
    expect(msgs[1]).toMatchObject({
      type: "usage_update",
      sessionId: "s1",
      subAgent: true,
      cumulativeInputTokens: 1000,
      cumulativeOutputTokens: 200,
    });
    expect(msgs[2]).toMatchObject({
      type: "sub_agent_consult_card",
      // docs/220 — the card carries the sub-agent's verbatim output so the
      // brokered consult is visible, not just attested.
      card: expect.objectContaining({
        subAgentId: "codex",
        status: "success",
        durationMs: 4200,
        costUsd: 0.03,
        outputMarkdown: "2 bugs found",
      }),
    });
    // the spinner and the card share a spawnId (the card clears the spinner)
    expect((msgs[2] as unknown as { card: { spawnId: string } }).card.spawnId).toBe(
      (msgs[0] as unknown as { spawnId: string }).spawnId,
    );
    // the card was persisted in-band (not emit-only) — survives switch/reload
    expect(replaceInProgress).toHaveBeenCalled();
  });

  it("forwards a carried-back rate-limit snapshot into the sub-agent's limits provider", async () => {
    const rateLimits = {
      session: { usedPct: 55, resetAt: "2026-06-13T05:00:00Z" },
      weekly: { usedPct: 12, resetAt: "2026-06-20T00:00:00Z" },
    };
    const { deps, recordAgentRateLimits } = makeDeps({
      spawnResult: { status: "success", text: "ok", truncated: false, durationMs: 1000, costUsd: 0, rateLimits },
    });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    // attributed to the sub-agent (codex), so its pill — not the pinned agent's — refreshes
    expect(recordAgentRateLimits).toHaveBeenCalledWith("codex", rateLimits.session, rateLimits.weekly);
  });

  it("does not touch the limits provider when the consult pushed no rate-limit snapshot", async () => {
    const { deps, recordAgentRateLimits } = makeDeps({
      spawnResult: { status: "success", text: "ok", truncated: false, durationMs: 1000, costUsd: 0 },
    });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    expect(recordAgentRateLimits).not.toHaveBeenCalled();
  });

  it("omits outputMarkdown when the sub-agent returned empty text (docs/220)", async () => {
    const { deps, emitMessage } = makeDeps({
      spawnResult: { status: "success", text: "", truncated: false, durationMs: 1000, costUsd: 0 },
    });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    const card = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { outputMarkdown?: string } })
      .find((m) => m.type === "sub_agent_consult_card")?.card;
    expect(card?.outputMarkdown).toBeUndefined();
  });

  it("gives each brokered call its own card id — no patch-in-place (docs/220)", async () => {
    const { deps, emitMessage } = makeDeps({});
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "re-review", depth: 0 });
    const cardIds = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { cardId?: string } })
      .filter((m) => m.type === "sub_agent_consult_card")
      .map((m) => m.card?.cardId);
    expect(cardIds).toHaveLength(2);
    expect(cardIds[0]).not.toBe(cardIds[1]);
  });

  it("emits an error consult card when the spawn throws (spinner never left spinning)", async () => {
    const { deps, runner, emitMessage } = makeDeps({});
    runner.spawnSubAgent = vi.fn(async () => {
      throw new Error("worker unreachable");
    });
    await expect(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 })).rejects.toThrow(
      "worker unreachable",
    );
    const msgs = emitMessage.mock.calls.map((c) => c[0] as { type: string });
    expect(msgs[0]).toMatchObject({ type: "sub_agent_spawn" });
    expect(msgs[1]).toMatchObject({
      type: "sub_agent_consult_card",
      card: expect.objectContaining({ status: "error" }),
    });
    // a transport failure produced no result, so there is no output to carry
    expect((msgs[1] as unknown as { card: { outputMarkdown?: string } }).card.outputMarkdown).toBeUndefined();
  });

  it("allows a same-provider spawn (no extra credentials needed)", async () => {
    // session pinned to claude, sub-agent also claude → no cross-provider window
    const { deps, runner } = makeDeps({ session: { id: "s1", agentId: "claude", agentPinned: true } });
    const res = await runSubAgent(deps, "s1", { subAgentId: "claude", prompt: "draft tests", depth: 0 });
    expect(res.status).toBe("success");
    expect(runner.spawnSubAgent).toHaveBeenCalled();
  });

  it("counts the spawn against the budget up to the cap across calls", async () => {
    const { deps, runner } = makeDeps({});
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "a", depth: 0 });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "b", depth: 0 });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "c", depth: 0 });
    expect(runner.subAgentSpawnsThisTurn).toBe(3);
    await expectServiceError(runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "d", depth: 0 }), 429);
  });
});

describe("sweepSubAgentCredentialsOnSignOut", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-creds-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("wipes cross-agent creds from sessions where the agent is NOT pinned, leaves pinned ones", () => {
    // Seed a fake source-of-truth .codex subtree so provisioning has something to copy.
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "auth.json"), "{}");

    // Session A is pinned to claude (codex would be a sub-agent) → provisioned codex subtree.
    provisionSubAgentCredentials(root, "sessA", "codex");
    // Session B is pinned to codex → it legitimately holds .codex; must NOT be wiped.
    provisionSubAgentCredentials(root, "sessB", "codex");

    const dirA = path.join(perSessionCredentialsDir(root, "sessA"), ".codex");
    const dirB = path.join(perSessionCredentialsDir(root, "sessB"), ".codex");
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);

    const sessionManager = {
      list: () => [
        { id: "sessA", agentId: "claude" },
        { id: "sessB", agentId: "codex" },
      ],
    } as never;

    sweepSubAgentCredentialsOnSignOut("codex", { sessionManager, credentialsDir: root });

    expect(fs.existsSync(dirA)).toBe(false); // swept (codex not pinned here)
    expect(fs.existsSync(dirB)).toBe(true); // preserved (codex is the pinned agent)
  });

  it("is a no-op without a credentialsDir (local mode)", () => {
    const sessionManager = { list: () => [{ id: "sessA", agentId: "claude" }] } as never;
    expect(() => sweepSubAgentCredentialsOnSignOut("codex", { sessionManager })).not.toThrow();
  });
});
