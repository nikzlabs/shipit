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
import { getSubAgentResult, runSubAgent, sweepSubAgentCredentialsOnSignOut, SUB_AGENT_PER_TURN_CAP } from "./sub-agent.js";
import { ServiceError } from "./types.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import { SUB_AGENT_TRANSPORT_TIMEOUT_MS } from "../../shared/sub-agent-run.js";
import { WorkerAbortedError, WorkerTimeoutError } from "../worker-http.js";
import type { AccountSelection } from "../provider-account-manager.js";
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
  spawnResults?: SubAgentRunResult[];
  runnerPresent?: boolean;
  subAgentDefaults?: { reasoningEffort?: string; model?: string };
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
  // SHI-278 — the pending → terminal transition patches the finalized DB row
  // whenever the originating turn is no longer holding the card.
  const updateSubAgentConsultCard = vi.fn(() => true);
  // emitChatCard reads chatMessageGroups/steeredMessages and mutates recordedCards,
  // then persists via chatHistoryManager.replaceInProgress — stub all four.
  const runner = {
    subAgentSpawnsThisTurn: opts.subAgentSpawnsThisTurn ?? 0,
    emitMessage,
    chatMessageGroups: [] as never[],
    steeredMessages: [] as never[],
    recordedCards: [] as never[],
    spawnSubAgent: vi.fn(async () =>
      opts.spawnResults?.shift() ?? opts.spawnResult ?? {
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
  const selectAccountForTurn = vi.fn((_provider: string, selectOpts?: { exclude?: string[] }): AccountSelection => ({
    ok: true as const,
    route: { kind: "account" as const, id: selectOpts?.exclude?.length ? "acct-secondary" : "acct-primary" },
  }));
  const markAccountExhausted = vi.fn();
  const deps = {
    sessionManager: {
      get: vi.fn((id: string) => (session?.id === id ? session : undefined)),
      list: vi.fn(() => opts.sessions ?? []),
    } as never,
    credentialStore: {
      getEnableSubAgents: () => opts.enableSubAgents ?? true,
      getAgentSubAgentDefaults: () => opts.subAgentDefaults ?? {},
    } as never,
    agentRegistry: {
      refreshAuth: vi.fn(),
      get: vi.fn(() => (opts.agentKnown === false ? undefined : { name: "Codex", authConfigured: opts.authConfigured ?? true })),
    } as never,
    runnerRegistry: { get: vi.fn(() => (opts.runnerPresent === false ? undefined : runner)) } as never,
    providerAccountManager: { selectAccountForTurn, markAccountExhausted } as never,
    usageManager: { record, getSessionUsage, getSessionTokenTotals } as never,
    recordAgentRateLimits,
    chatHistoryManager: { replaceInProgress, updateSubAgentConsultCard } as never,
  };
  return {
    deps, runner, emitMessage, record, replaceInProgress, updateSubAgentConsultCard,
    recordAgentRateLimits, selectAccountForTurn, markAccountExhausted,
  };
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
    // transient running spinner, the DURABLE pending card (SHI-278), the live
    // bill refresh, then the terminal consult card.
    const msgs = emitMessage.mock.calls.map((c) => c[0] as { type: string });
    // The spinner carries the OWNING session id so the client can drop it when
    // it arrives for a session other than the one being viewed.
    expect(msgs[0]).toMatchObject({ type: "sub_agent_spawn", sessionId: "s1", subAgentId: "codex" });
    expect(msgs[1]).toMatchObject({
      type: "sub_agent_consult_card",
      card: expect.objectContaining({ subAgentId: "codex", status: "pending" }),
    });
    // the bill update is flagged subAgent so it doesn't move the context dial
    expect(msgs[2]).toMatchObject({
      type: "usage_update",
      sessionId: "s1",
      subAgent: true,
      cumulativeInputTokens: 1000,
      cumulativeOutputTokens: 200,
    });
    expect(msgs[3]).toMatchObject({
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
    expect((msgs[3] as unknown as { card: { spawnId: string } }).card.spawnId).toBe(
      (msgs[0] as unknown as { spawnId: string }).spawnId,
    );
    // SHI-278 — the pending and terminal deliveries are ONE card, patched in
    // place. Two ids would render two rows for one consult.
    expect((msgs[3] as unknown as { card: { cardId: string } }).card.cardId).toBe(
      (msgs[1] as unknown as { card: { cardId: string } }).card.cardId,
    );
    // the card was persisted in-band (not emit-only) — survives switch/reload
    expect(replaceInProgress).toHaveBeenCalled();
  });

  it("returns the caller the SAME text it puts on the card, under one run id (SHI-245)", async () => {
    const { deps, emitMessage } = makeDeps({
      spawnResult: {
        status: "success",
        // A two-message answer — the exact shape that used to reach the caller
        // as its tail only.
        text: "The plan is viable, but…\n\nI found nine definite problems.",
        truncated: false,
        durationMs: 1102_000,
        costUsd: 0,
      },
    });
    const res = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

    // the LAST consult-card emission is the terminal one (the first is pending)
    const card = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { spawnId: string; outputMarkdown?: string } })
      .filter((m) => m.type === "sub_agent_consult_card")
      .at(-1)?.card;
    // What the agent acts on and what the user reads are one document, named by
    // one id — divergence here is the SHI-245 failure, silent and undetectable.
    expect(card?.outputMarkdown).toBe(res.text);
    expect(res.spawnId).toBe(card?.spawnId);
  });

  it("forwards the invoked agent's global reasoning + model defaults to the spawn (docs/217)", async () => {
    const { deps, runner } = makeDeps({ subAgentDefaults: { reasoningEffort: "high", model: "gpt-5.5" } });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    expect(runner.spawnSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "codex", reasoningEffort: "high", model: "gpt-5.5" }),
    );
  });

  it("omits reasoningEffort + model when no defaults are set — backend uses its own default", async () => {
    const { deps, runner } = makeDeps({ subAgentDefaults: {} });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    const calls = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } }).mock.calls;
    const arg = calls[0][0];
    expect(arg).not.toHaveProperty("reasoningEffort");
    expect(arg).not.toHaveProperty("model");
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

  it("selects a healthy subscription account proactively for a one-shot run", async () => {
    const { deps, runner, selectAccountForTurn } = makeDeps({});
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    expect(selectAccountForTurn).toHaveBeenCalledWith("codex");
    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(1);
  });

  it("benches a hard-exhausted account and retries once on the next subscription", async () => {
    const resetAt = "2099-08-02T12:00:00.000Z";
    const { deps, runner, selectAccountForTurn, markAccountExhausted } = makeDeps({
      spawnResults: [
        { status: "error", text: "", error: `Weekly usage limit reached. It resets at ${resetAt}.`, truncated: false, durationMs: 10, costUsd: 0 },
        { status: "success", text: "review complete", truncated: false, durationMs: 20, costUsd: 0 },
      ],
    });
    const result = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    expect(markAccountExhausted).toHaveBeenCalledWith("codex", "acct-primary", Date.parse(resetAt));
    expect(selectAccountForTurn).toHaveBeenLastCalledWith("codex", { exclude: ["acct-primary"] });
    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("review complete");
  });

  it("continues across exhausted accounts until a healthy subscription succeeds", async () => {
    const resetAt = "2099-08-02T12:00:00.000Z";
    const { deps, runner, selectAccountForTurn, markAccountExhausted } = makeDeps({
      spawnResults: [
        { status: "error", text: "", error: `Weekly usage limit reached. It resets at ${resetAt}.`, truncated: false, durationMs: 10, costUsd: 0 },
        { status: "error", text: "", error: "Quota exhausted", truncated: false, durationMs: 10, costUsd: 0 },
        { status: "success", text: "third account worked", truncated: false, durationMs: 20, costUsd: 0 },
      ],
    });
    selectAccountForTurn
      .mockReturnValueOnce({ ok: true, route: { kind: "account", id: "acct-primary" } })
      .mockReturnValueOnce({ ok: true, route: { kind: "account", id: "acct-secondary" } })
      .mockReturnValueOnce({ ok: true, route: { kind: "account", id: "acct-tertiary" } });

    const result = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(3);
    expect(markAccountExhausted).toHaveBeenCalledTimes(2);
    expect(selectAccountForTurn).toHaveBeenNthCalledWith(3, "codex", {
      exclude: ["acct-primary", "acct-secondary"],
    });
    expect(result.text).toBe("third account worked");
  });

  it("reports the earliest reset after every eligible account is exhausted", async () => {
    const earliestResetAt = "2099-08-02T11:00:00.000Z";
    const { deps, runner, selectAccountForTurn } = makeDeps({
      spawnResults: [
        { status: "error", text: "", error: "Weekly usage limit reached", truncated: false, durationMs: 10, costUsd: 0 },
        { status: "error", text: "", error: "Quota exhausted", truncated: false, durationMs: 10, costUsd: 0 },
      ],
    });
    selectAccountForTurn
      .mockReturnValueOnce({ ok: true, route: { kind: "account", id: "acct-primary" } })
      .mockReturnValueOnce({ ok: true, route: { kind: "account", id: "acct-secondary" } })
      .mockReturnValueOnce({ ok: false, reason: "all_exhausted", earliestResetAt });

    const result = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("error");
    expect(result.error).toBe(
      "Every connected Codex subscription account is out of quota. Earliest reset: 2099-08-02T11:00:00.000Z.",
    );
  });

  it("does not retry a model-access error", async () => {
    const { deps, runner, markAccountExhausted } = makeDeps({
      spawnResult: { status: "error", text: "", error: "This account cannot access model opus", truncated: false, durationMs: 10, costUsd: 0 },
    });
    const result = await runSubAgent(deps, "s1", { subAgentId: "claude", prompt: "review", depth: 0 });
    expect(result.status).toBe("error");
    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(1);
    expect(markAccountExhausted).not.toHaveBeenCalled();
  });

  it("omits outputMarkdown when the sub-agent returned empty text (docs/220)", async () => {
    const { deps, emitMessage } = makeDeps({
      spawnResult: { status: "success", text: "", truncated: false, durationMs: 1000, costUsd: 0 },
    });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    const card = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { outputMarkdown?: string } })
      .filter((m) => m.type === "sub_agent_consult_card")
      .at(-1)?.card;
    expect(card?.outputMarkdown).toBeUndefined();
  });

  it("gives each brokered call its own card id — one card per run, patched in place", async () => {
    const { deps, emitMessage } = makeDeps({});
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "re-review", depth: 0 });
    const cardIds = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { cardId?: string } })
      .filter((m) => m.type === "sub_agent_consult_card")
      .map((m) => m.card?.cardId);
    // SHI-278 — two runs × (pending + terminal) = 4 emissions, but only TWO
    // distinct cards: each run's pending row is patched, not duplicated.
    expect(cardIds).toHaveLength(4);
    expect(new Set(cardIds).size).toBe(2);
    expect(cardIds[0]).toBe(cardIds[1]);
    expect(cardIds[2]).toBe(cardIds[3]);
    expect(cardIds[0]).not.toBe(cardIds[2]);
  });

  it("finalizes the pending card as an error when the spawn throws (never left pending)", async () => {
    const { deps, runner, emitMessage, updateSubAgentConsultCard } = makeDeps({});
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
      card: expect.objectContaining({ status: "pending" }),
    });
    expect(msgs[2]).toMatchObject({
      type: "sub_agent_consult_card",
      card: expect.objectContaining({ status: "error" }),
    });
    // a transport failure produced no result, so there is no output to carry
    expect((msgs[2] as unknown as { card: { outputMarkdown?: string } }).card.outputMarkdown).toBeUndefined();
    // the terminal state landed in the DB too — the transcript can't stay pending
    expect(updateSubAgentConsultCard).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({ status: "error" }),
    );
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

/**
 * SHI-278 — the in-flight consult card's lifecycle. The incident: a
 * backgrounded Codex consult ran for 15 minutes, the user switched sessions
 * (wiping the transient spinner), then hit Restart agent. Nothing survived — no
 * in-flight surface, no terminal card, and `shipit agent result` was empty.
 */
describe("runSubAgent — durable in-flight consult card", () => {
  it("persists a pending card at spawn time, before the run finishes", async () => {
    let cardAtSpawn: { status: string } | undefined;
    const { deps, runner, replaceInProgress } = makeDeps({});
    runner.spawnSubAgent = vi.fn(async () => {
      // Observed from INSIDE the run: what a session switch would rehydrate.
      cardAtSpawn = (runner.recordedCards as unknown as { message: { subAgentConsult: { status: string } } }[])
        .at(-1)?.message.subAgentConsult;
      expect(replaceInProgress).toHaveBeenCalled();
      return { status: "success", text: "done", truncated: false, durationMs: 10, costUsd: 0 };
    });
    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    expect(cardAtSpawn).toMatchObject({ status: "pending" });
  });

  it("patches the finalized DB row when the originating turn already ended", async () => {
    // The common shape after docs/236: the agent backgrounds a long consult, its
    // turn finalizes, and the result lands during a LATER turn. Re-recording
    // into that later turn would both misplace the card and revive a finalized
    // turn as a duplicate in-progress row.
    const { deps, runner, updateSubAgentConsultCard, replaceInProgress } = makeDeps({});
    let persistsAtSpawn = 0;
    runner.spawnSubAgent = vi.fn(async () => {
      // The turn that issued the consult has finalized; its recorded cards are
      // cleared by the next turn's `resetRunnerTurnState`.
      persistsAtSpawn = replaceInProgress.mock.calls.length;
      (runner as unknown as { running: boolean }).running = false;
      runner.recordedCards = [] as never[];
      return { status: "success", text: "9 findings", truncated: false, durationMs: 900_000, costUsd: 0 };
    });

    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

    expect(updateSubAgentConsultCard).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({ status: "success", outputMarkdown: "9 findings" }),
    );
    // no FURTHER in-progress rebuild after the pending persist — the finalized
    // turn is not revived as a duplicate in-progress row
    expect(replaceInProgress.mock.calls.length).toBe(persistsAtSpawn);
  });

  it("lands a cancelled card through the LIVE runner when the original was disposed", async () => {
    // Restart agent force-disposes the runner and destroys the container under
    // the in-flight spawn. Emitting through the disposed runner drops the live
    // card AND clobbers persisted rows from its stale turn state — so the runner
    // is re-resolved from the registry at completion time.
    const { deps, runner, emitMessage, updateSubAgentConsultCard } = makeDeps({});
    const liveEmit = vi.fn();
    const liveRunner = {
      running: false,
      emitMessage: liveEmit,
      chatMessageGroups: [] as never[],
      steeredMessages: [] as never[],
      recordedCards: [] as never[],
    };
    runner.spawnSubAgent = vi.fn(async () => {
      // The registry hands out the REPLACEMENT runner once the old one is gone.
      (deps.runnerRegistry as unknown as { get: ReturnType<typeof vi.fn> }).get =
        vi.fn(() => liveRunner);
      throw new WorkerAbortedError("/agent/spawn", "runner disposed");
    });

    await expect(
      runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }),
    ).rejects.toBeInstanceOf(WorkerAbortedError);

    // An abort is a cancellation, not a fault.
    expect(liveEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sub_agent_consult_card",
        card: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    // and NOT through the disposed runner, whose viewers are gone
    const staleTerminal = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { status?: string } })
      .filter((m) => m.type === "sub_agent_consult_card" && m.card?.status !== "pending");
    expect(staleTerminal).toHaveLength(0);
    // the cancellation is durable — a reload shows "Cancelled", not "Asking…"
    expect(updateSubAgentConsultCard).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("finalizes as a timeout when the transport backstop fires", async () => {
    const { deps, runner, updateSubAgentConsultCard } = makeDeps({});
    runner.spawnSubAgent = vi.fn(async () => {
      throw new WorkerTimeoutError("/agent/spawn", SUB_AGENT_TRANSPORT_TIMEOUT_MS);
    });
    await expect(
      runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }),
    ).rejects.toBeInstanceOf(WorkerTimeoutError);
    expect(updateSubAgentConsultCard).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({ status: "timeout" }),
    );
  });
});

describe("getSubAgentResult (SHI-245)", () => {
  const card = (spawnId: string, outputMarkdown: string) => ({
    cardId: `c-${spawnId}`,
    spawnId,
    subAgentId: "codex" as const,
    status: "success" as const,
    outputMarkdown,
    createdAt: "2026-07-28T00:00:00Z",
  });

  const reader = (cards: ReturnType<typeof card>[]) => ({
    chatHistoryManager: { listSubAgentConsultCards: () => cards },
  });

  it("returns the most recent run when no id is given", () => {
    const found = getSubAgentResult(reader([card("aaa1", "old"), card("bbb2", "newest")]), "s1");
    expect(found.spawnId).toBe("bbb2");
  });

  it("returns the named run — this is the recovery path for a killed `agent run`", () => {
    const found = getSubAgentResult(reader([card("aaa1", "first"), card("bbb2", "second")]), "s1", "aaa1");
    expect(found.outputMarkdown).toBe("first");
  });

  it("accepts an unambiguous id prefix", () => {
    const found = getSubAgentResult(reader([card("aaa1", "first"), card("bbb2", "second")]), "s1", "bb");
    expect(found.spawnId).toBe("bbb2");
  });

  it("refuses an ambiguous prefix rather than guessing a run", () => {
    expect(() => getSubAgentResult(reader([card("aaa1", "x"), card("aaa2", "y")]), "s1", "aaa")).toThrow(
      ServiceError,
    );
  });

  it("404s when the session has no runs, and when the id is unknown", () => {
    expect(() => getSubAgentResult(reader([]), "s1")).toThrow(/No sub-agent runs/);
    expect(() => getSubAgentResult(reader([card("aaa1", "x")]), "s1", "zzz")).toThrow(/No sub-agent run with id/);
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
