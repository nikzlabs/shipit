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
import {
  getSubAgentResult,
  runSubAgent,
  sweepSubAgentCredentialsOnSignOut,
  waitForSubAgentResult,
  SUB_AGENT_PER_TURN_CAP,
} from "./sub-agent.js";
import { ServiceError } from "./types.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { ChatHistoryManager } from "../chat-history.js";
import { persistTurnInProgress } from "../chat-card-persistence.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import type * as InstalledHarnesses from "../../shared/installed-harnesses.js";
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

/**
 * docs/252 phase 9 — harnesses this "deployment" declares it does NOT have.
 * Empty by default: with no declaration nothing is refused for not being
 * installed, which is the report-less (CI, dev checkout) case.
 */
const uninstalledHarnesses = new Set<string>();
vi.mock("../../shared/installed-harnesses.js", async (importOriginal) => {
  const actual = await importOriginal<typeof InstalledHarnesses>();
  return { ...actual, isHarnessInstalled: (id: string) => !uninstalledHarnesses.has(id) };
});

afterEach(() => uninstalledHarnesses.clear());

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
  // planning#280 — the pending → terminal transition patches the finalized DB row
  // whenever the originating turn is no longer holding the card.
  const updateSubAgentConsultCard = vi.fn(() => true);
  const append = vi.fn();
  // emitChatCard reads chatMessageGroups/steeredMessages and mutates recordedCards,
  // then persists via chatHistoryManager.replaceInProgress — stub all four.
  const runner = {
    subAgentSpawnsThisTurn: opts.subAgentSpawnsThisTurn ?? 0,
    // A FOREGROUND consult: the invoking agent is blocked waiting, so its turn
    // is still in flight and the card rides the in-progress turn. The
    // backgrounded (post-turn) case has its own describe block below.
    running: true,
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
      get: vi.fn(() => (opts.agentKnown === false
        ? undefined
        : {
            name: "Codex",
            installed: true,
            authConfigured: opts.authConfigured ?? true,
            // docs/252 phase 3 — a real registry entry carries the eligible set,
            // and an UNSET sub-agent default resolves to its first entry rather
            // than leaving the consult selectionless.
            eligibleModels: [
              {
                serviceId: "openai",
                serviceName: "OpenAI",
                billingMode: "sub",
                modelId: "gpt-5.6-sol",
                label: "GPT-5.6 Sol",
              },
            ],
          })),
    } as never,
    runnerRegistry: { get: vi.fn(() => (opts.runnerPresent === false ? undefined : runner)) } as never,
    providerAccountManager: { selectAccountForTurn, markAccountExhausted } as never,
    usageManager: { record, getSessionUsage, getSessionTokenTotals } as never,
    recordAgentRateLimits,
    chatHistoryManager: { replaceInProgress, append, updateSubAgentConsultCard } as never,
  };
  return {
    deps, runner, emitMessage, record, replaceInProgress, append, updateSubAgentConsultCard,
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

  // docs/252 phase 9 (req 14) — a harness this deployment did not install offers
  // nothing, credentials or not. Checked BEFORE auth: "connect it in Settings"
  // would be a dead end for a harness that is not here.
  it("rejects a harness this deployment did not install (400)", async () => {
    uninstalledHarnesses.add("codex");
    const { deps, runner } = makeDeps({});
    const err = await expectServiceError(
      runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 }), 400);
    expect(err.message).toMatch(/not installed in this deployment/);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
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
    //
    // docs/252 phase 3 — and with an explicit cost SOURCE plus full attribution.
    // A one-shot consult's figure is already this run's own, which `record()`
    // previously inferred from `subAgentId` being set; the discriminator states
    // it instead, so a rate-derived figure and a harness running total can
    // coexist. The attribution is present even though this fixture sets NO
    // sub-agent default: an unset default means "the harness's first model", so
    // it resolves to the first eligible entry rather than writing a `legacy`
    // row — which is supposed to mean "before ShipIt tracked this", not "this
    // install never opened the Settings tab".
    // The cost is ZERO, not the consult's reported 0.03: the resolved selection
    // is a SUBSCRIPTION, and a subscription turn spends no money (req 16). The
    // rates ride along in `attribution` so phase 6 can still say what it would
    // have cost at API rates.
    expect(record).toHaveBeenCalledWith("s1", 0, 4200, 1000, 200, {
      subAgentId: "codex",
      costSource: "per-turn",
      model: "gpt-5.6-sol",
      attribution: expect.objectContaining({ serviceId: "openai", billingMode: "sub" }),
      contextTokens: 1200,
    });
    // transient running spinner, the DURABLE pending card (planning#280), the live
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
    // planning#280 — the pending and terminal deliveries are ONE card, patched in
    // place. Two ids would render two rows for one consult.
    expect((msgs[3] as unknown as { card: { cardId: string } }).card.cardId).toBe(
      (msgs[1] as unknown as { card: { cardId: string } }).card.cardId,
    );
    // the card was persisted in-band (not emit-only) — survives switch/reload
    expect(replaceInProgress).toHaveBeenCalled();
  });

  it("returns the caller the SAME text it puts on the card, under one run id (planning#247)", async () => {
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
    // one id — divergence here is the planning#247 failure, silent and undetectable.
    expect(card?.outputMarkdown).toBe(res.text);
    expect(res.spawnId).toBe(card?.spawnId);
  });

  it("emits a long consult as its preview line while persisting the whole output (docs/244, planning#299)", async () => {
    // The card face draws one 140-character line and the viewer is a click away,
    // so under requirement 1 the rest doesn't belong on the wire. What must NOT
    // change is the stored copy: it is what the fetch endpoint serves and what
    // `shipit agent result` reads back, so planning#247's "one artifact, two
    // surfaces" still holds — the preview is a transport detail, not a second
    // extraction.
    const review = Array.from({ length: 300 }, (_, i) => `finding ${i}`).join("\n");
    const { deps, emitMessage, replaceInProgress } = makeDeps({
      spawnResult: { status: "success", text: review, truncated: false, durationMs: 900_000, costUsd: 0 },
    });

    const res = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

    const emitted = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { outputMarkdown?: string; outputTruncated?: true } })
      .filter((m) => m.type === "sub_agent_consult_card")
      .at(-1)?.card;
    expect(emitted?.outputTruncated).toBe(true);
    expect(emitted?.outputMarkdown).not.toContain("finding 299");

    // The caller still gets the whole thing…
    expect(res.text).toBe(review);
    // …and so does chat history, which is where the fetch resolves against.
    const persistedCard = replaceInProgress.mock.calls
      .map((c) => c[1] as { subAgentConsult?: { outputMarkdown?: string; outputTruncated?: true } }[])
      .at(-1)
      ?.find((m) => m.subAgentConsult);
    expect(persistedCard?.subAgentConsult?.outputMarkdown).toBe(review);
    expect(persistedCard?.subAgentConsult?.outputTruncated).toBeUndefined();
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
    // docs/252 phase 3 — the MODEL is no longer omitted. An unset default means
    // "the harness's own first model", and leaving it out made the adapter pick
    // that from the whole catalogue join — which on an install with no
    // first-party credential is a model it cannot run. Resolving it here also
    // makes what runs and what is recorded the same by construction.
    expect(arg.model).toBe("gpt-5.6-sol");
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
    // Attributed to the sub-agent (codex), so its pill — not the pinned
    // agent's — refreshes. docs/252 req 10 adds the session AND the route the
    // consult actually ran on: quota is filed against whatever `(service,
    // mode)` owns that route, so letting the orchestrator re-derive one would
    // name a credential this consult never used.
    const call = recordAgentRateLimits.mock.calls[0];
    expect(call.slice(0, 4)).toEqual(["codex", rateLimits.session, rateLimits.weekly, "s1"]);
    // The 5th argument is the consult's OWN resolved route id, which is what
    // stops the orchestrator re-deriving one from the session.
    expect(call).toHaveLength(5);
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

  // Same blind spot as a primary turn: a consult that hits the limit mid-run
  // gets the notice as its final assistant text and still reports `success`,
  // so gating the fallback on `error` alone silently returned the notice as
  // the consult's answer instead of failing over.
  it("benches and retries when the limit arrives as the run's final text on a success", async () => {
    const { deps, runner, markAccountExhausted } = makeDeps({
      spawnResults: [
        { status: "success", text: "You've hit your session limit · resets 5:10pm (UTC)", truncated: false, durationMs: 10, costUsd: 0 },
        { status: "success", text: "review complete", truncated: false, durationMs: 20, costUsd: 0 },
      ],
    });
    const result = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
    expect(markAccountExhausted).toHaveBeenCalledTimes(1);
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

  // A text-channel notice leaves `status: "success"`, so without the promotion
  // the consult renders as a completed review whose entire answer is the
  // provider's limit notice.
  it("fails the consult when the last account's limit arrived as final text", async () => {
    const earliestResetAt = "2099-08-02T11:00:00.000Z";
    const { deps, runner, selectAccountForTurn } = makeDeps({
      spawnResult: { status: "success", text: "You've hit your session limit · resets 5:10pm (UTC)", truncated: false, durationMs: 10, costUsd: 0 },
    });
    selectAccountForTurn
      .mockReturnValueOnce({ ok: true, route: { kind: "account", id: "acct-primary" } })
      .mockReturnValueOnce({ ok: false, reason: "all_exhausted", earliestResetAt });

    const result = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("error");
    expect(result.error).toContain("out of quota");
  });

  // The error is the provider talking; only when it is silent do we read the
  // model's words. A non-quota failure whose partial output happens to look
  // like a notice must not bench a healthy account.
  it("does not read the text channel when the run carries a non-quota error", async () => {
    const { deps, runner, markAccountExhausted } = makeDeps({
      spawnResult: { status: "error", text: "You've hit your session limit · resets 5:10pm (UTC)", error: "This account cannot access model opus", truncated: false, durationMs: 10, costUsd: 0 },
    });
    const result = await runSubAgent(deps, "s1", { subAgentId: "claude", prompt: "review", depth: 0 });
    expect(result.status).toBe("error");
    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(1);
    expect(markAccountExhausted).not.toHaveBeenCalled();
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
    // planning#280 — two runs × (pending + terminal) = 4 emissions, but only TWO
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
      // The backgrounded shape docs/236 recommends: the launching turn ends
      // while the consult is still in flight, so the terminal state has to land
      // via the finalized-DB-row patch rather than this turn's recorded card.
      runner.running = false;
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
 * planning#280 — the in-flight consult card's lifecycle. The incident: a
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
      runner.running = false; // backgrounded: the launching turn ended first
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

describe("getSubAgentResult (planning#247)", () => {
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

/**
 * docs/248 — `waitForSubAgentResult` backs `shipit agent result --wait`, whose
 * whole point is that a caller which backgrounded a long consult never has to
 * script a sleep/grep loop. The properties worth pinning are the ones that make
 * the wait safe to interrupt and safe to retry.
 */
describe("waitForSubAgentResult (docs/248)", () => {
  type Status = "pending" | "success" | "error" | "timeout" | "cancelled";
  const card = (spawnId: string, status: Status, outputMarkdown = "") => ({
    cardId: `c-${spawnId}`,
    spawnId,
    subAgentId: "codex" as const,
    status,
    outputMarkdown,
    createdAt: "2026-08-04T00:00:00Z",
  });

  /**
   * A reader whose card list is re-read on every call, plus a virtual clock the
   * wait's own `sleep` advances — so the loop's timing is exercised
   * deterministically without real timers.
   */
  function harness(states: ReturnType<typeof card>[][]) {
    let reads = 0;
    let clock = 0;
    const deps = {
      chatHistoryManager: {
        listSubAgentConsultCards: () => states[Math.min(reads++, states.length - 1)],
      },
    };
    return {
      deps,
      readCount: () => reads,
      opts: {
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
      },
    };
  }

  it("returns immediately when the run is already terminal — no polling at all", async () => {
    const h = harness([[card("aaa1", "success", "done")]]);
    const res = await waitForSubAgentResult(h.deps, "s1", { segmentMs: 60_000, ...h.opts });
    expect(res.outcome).toBe("finished");
    expect(res.card.outputMarkdown).toBe("done");
    // The fast-path derive only — a terminal run must not arm the loop.
    expect(h.readCount()).toBe(1);
  });

  it("resolves as soon as the card flips pending → terminal", async () => {
    const h = harness([
      [card("aaa1", "pending")],
      [card("aaa1", "pending")],
      [card("aaa1", "success", "the review")],
    ]);
    const res = await waitForSubAgentResult(h.deps, "s1", { segmentMs: 60_000, ...h.opts });
    expect(res.outcome).toBe("finished");
    expect(res.card.outputMarkdown).toBe("the review");
  });

  it("reports a non-success terminal status as finished — the wait is over either way", async () => {
    const h = harness([[card("aaa1", "pending")], [card("aaa1", "error")]]);
    const res = await waitForSubAgentResult(h.deps, "s1", { segmentMs: 60_000, ...h.opts });
    expect(res.outcome).toBe("finished");
    expect(res.card.status).toBe("error");
  });

  it("resolves `pending` when the segment elapses, so the shim can re-issue", async () => {
    const h = harness([[card("aaa1", "pending")]]);
    const res = await waitForSubAgentResult(h.deps, "s1", { segmentMs: 2_000, ...h.opts });
    expect(res.outcome).toBe("pending");
    expect(res.card.spawnId).toBe("aaa1");
  });

  it("pins the run on the first derive — a newer run started mid-wait must not hijack it", async () => {
    // No spawnId ⇒ "the most recent run". A second consult starts while we are
    // waiting; without pinning, "most recent" would silently switch to it and
    // report ITS status as the answer to a question about the first run.
    const h = harness([
      [card("aaa1", "pending")],
      [card("aaa1", "pending"), card("bbb2", "success", "other run")],
      [card("aaa1", "success", "the run we asked about"), card("bbb2", "success", "other run")],
    ]);
    const res = await waitForSubAgentResult(h.deps, "s1", { segmentMs: 60_000, ...h.opts });
    expect(res.card.spawnId).toBe("aaa1");
    expect(res.card.outputMarkdown).toBe("the run we asked about");
  });

  it("throws on a bad run id from the first derive, without polling a full segment", async () => {
    const h = harness([[card("aaa1", "pending")]]);
    await expect(
      waitForSubAgentResult(h.deps, "s1", { spawnId: "zzz", segmentMs: 60_000, ...h.opts }),
    ).rejects.toThrow(/No sub-agent run with id/);
    expect(h.readCount()).toBe(1);
  });

  it("keeps waiting when the card is momentarily unreadable mid-wait", async () => {
    // A history rewrite between two polls must not be reported as "the run
    // vanished" — a lookup that was valid once is not re-validated into failure.
    const h = harness([
      [card("aaa1", "pending")],
      [], // transient: nothing readable this instant
      [card("aaa1", "success", "recovered")],
    ]);
    const res = await waitForSubAgentResult(h.deps, "s1", { segmentMs: 60_000, ...h.opts });
    expect(res.outcome).toBe("finished");
    expect(res.card.outputMarkdown).toBe("recovered");
  });
});

/**
 * The guarantee `getSubAgentResult`'s docstring makes: **the result outlives the
 * call**. A `shipit agent run` launched in the background — which
 * `shipit-docs/agent.md` actively tells the agent to do, because a long consult
 * outlasts the invoking agent's foreground shell cap — finishes server-side
 * after the launching turn has ended, and its output must still be re-readable
 * afterwards.
 *
 * It was not. The consult card went through `emitChatCard`'s in-progress path,
 * which re-inserted the ALREADY-FINALIZED turn as a second `in_progress=1` copy
 * with the card inside it; the next turn's first `replaceInProgress` deletes
 * every `in_progress=1` row for the session and deleted the card with it. In
 * production `shipit agent result ecb1fc11-…` answered "No sub-agent runs in
 * this session yet" for a run that had just printed that very id, and an
 * 18-minute Codex review was gone.
 *
 * These run against a REAL `ChatHistoryManager` on purpose: the failure lives
 * entirely in the delete/re-insert semantics of `replaceInProgress`, which a
 * `vi.fn()` stub cannot express. They assert the guarantee (the output is still
 * there) rather than which persistence path produced it.
 */
describe("a backgrounded consult that finishes AFTER its launching turn (planning#247)", () => {
  const OUTPUT = "## Findings\n\n- `foo.ts:42` — a real bug\n";
  const TURN_ONE_TEXT = "Launching a Codex review in the background…";

  /**
   * Two shapes a backgrounded consult actually takes, differing in whether the
   * launching turn is still open when the shim POSTs:
   *
   *  - `mid-turn` — the ordinary case. The agent runs `shipit agent run &`
   *    inside its turn, so the pending card rides that turn; the turn finalizes
   *    while the consult is still going, and only the terminal patch is
   *    post-turn.
   *  - `post-turn` — the shim fires from a background shell started in an
   *    EARLIER turn, so even the pending card arrives with no turn in flight.
   *    This is the shape `emitChatCard`'s post-turn append exists for: routed
   *    through the in-progress path the pending row is deleted by the next
   *    turn's `replaceInProgress`, and the terminal patch then has no row to
   *    find.
   *
   * Either way the run must still be re-readable afterwards.
   */
  function consultScenario(launch: "mid-turn" | "post-turn") {
    const dbManager = new DatabaseManager(":memory:");
    const chatHistoryManager = new ChatHistoryManager(dbManager);
    const finalizeTurnOne = () => {
      persistTurnInProgress(chatHistoryManager, runner as never, "s1");
      chatHistoryManager.finalizeInProgress("s1");
      runner.running = false;
    };
    const runner = {
      subAgentSpawnsThisTurn: 0,
      running: launch === "mid-turn",
      emitMessage: vi.fn(),
      chatMessageGroups: [{ text: TURN_ONE_TEXT, toolUse: [] }],
      steeredMessages: [],
      recordedCards: [],
      spawnSubAgent: vi.fn(async () => {
        // The launching turn ends while the consult is still in flight — the
        // whole reason the agent was told to background it.
        if (launch === "mid-turn") finalizeTurnOne();
        return {
          status: "success" as const,
          text: OUTPUT,
          truncated: false,
          durationMs: 1_100_000,
          costUsd: 0,
        };
      }),
    };

    chatHistoryManager.append("s1", { role: "user", text: "get Codex's read on this diff" });
    // In the post-turn shape the turn is already over before the shim POSTs.
    if (launch === "post-turn") finalizeTurnOne();

    const deps = {
      sessionManager: { get: () => ({ id: "s1", agentId: "claude", agentPinned: true }), list: () => [] },
      credentialStore: { getEnableSubAgents: () => true, getAgentSubAgentDefaults: () => ({}) },
      agentRegistry: { refreshAuth: vi.fn(), get: () => ({ name: "Codex", installed: true, authConfigured: true }) },
      runnerRegistry: { get: () => runner },
      usageManager: { record: vi.fn(), getSessionUsage: () => null, getSessionTokenTotals: () => null },
      chatHistoryManager,
    } as never;
    return { dbManager, chatHistoryManager, runner, deps };
  }

  /** Turn 2 begins: accumulators reset, then the first tool-result boundary. */
  function startTurnTwo(chatHistoryManager: ChatHistoryManager, runner: Record<string, unknown>) {
    runner.chatMessageGroups = [];
    runner.recordedCards = [];
    runner.steeredMessages = [];
    runner.running = true;
    chatHistoryManager.append("s1", { role: "user", text: "what did it say?" });
    runner.chatMessageGroups = [{ text: "Reading the run's result…", toolUse: [{}] }];
    persistTurnInProgress(chatHistoryManager, runner as never, "s1");
  }

  for (const launch of ["mid-turn", "post-turn"] as const) {
    describe(`launched ${launch}`, () => {
      it("is still re-readable by `shipit agent result <id>` a turn later", async () => {
        const { dbManager, chatHistoryManager, runner, deps } = consultScenario(launch);
        const res = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

        startTurnTwo(chatHistoryManager, runner as never);

        // The whole point of the feature: the invoking agent can recover the
        // output it may never have received, by the id the run printed.
        const byId = getSubAgentResult({ chatHistoryManager }, "s1", res.spawnId);
        expect(byId.outputMarkdown).toBe(OUTPUT);
        // …and with no id at all, which is the common recovery invocation.
        expect(getSubAgentResult({ chatHistoryManager }, "s1").spawnId).toBe(res.spawnId);
        dbManager.close();
      });

      it("is still in the transcript a session switch / full reload rehydrates from", async () => {
        const { dbManager, chatHistoryManager, runner, deps } = consultScenario(launch);
        await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });
        startTurnTwo(chatHistoryManager, runner as never);

        // Both rehydration paths CLAUDE.md calls out read `load()`. Exactly one
        // card: the pending row patched in place, never a second copy.
        const cards = chatHistoryManager.load("s1").filter((m) => m.subAgentConsult);
        expect(cards).toHaveLength(1);
        expect(cards[0].subAgentConsult?.status).toBe("success");
        expect(cards[0].subAgentConsult?.outputMarkdown).toBe(OUTPUT);
        dbManager.close();
      });

      it("does not duplicate the finished turn it landed after", async () => {
        const { dbManager, chatHistoryManager, deps } = consultScenario(launch);
        await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

        // The in-progress path revived the finished turn's assistant row as a
        // second copy, so the user saw the same message twice until the next
        // turn swept it — and the card — away.
        const echoes = chatHistoryManager.load("s1").filter((m) => m.text === TURN_ONE_TEXT);
        expect(echoes).toHaveLength(1);
        dbManager.close();
      });
    });
  }
});

/**
 * planning#301 — the wiring test for `commitSubAgentWork`. The gating/lock/notice
 * behaviour is pinned in `sub-agent-commit.test.ts`; what matters here is that
 * `runSubAgent` actually reaches it on the terminal path, so a consult that
 * outlives its turn no longer leaves its work uncommitted (the 100-minute Codex
 * run whose edits missed the merged PR).
 */
describe("runSubAgent — committing work a consult left after its turn ended (planning#301)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let git: GitManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-sub-agent-run-commit-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
    git = new GitManager(tmpDir);
    await git.init();
    fs.writeFileSync(path.join(tmpDir, "turn-work.txt"), "from the turn");
    await git.autoCommit("Agent turn");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function scenario(opts: { turnEndsDuringConsult: boolean }) {
    const schedulePostTurnPush = vi.fn();
    const runner = {
      subAgentSpawnsThisTurn: 0,
      sessionId: "s1",
      sessionDir: tmpDir,
      running: true,
      turnSummary: "Launching a Codex review in the background",
      pendingCommitLink: null as unknown,
      emitMessage: vi.fn(),
      schedulePostTurnPush,
      chatMessageGroups: [] as never[],
      steeredMessages: [] as never[],
      recordedCards: [] as never[],
      spawnSubAgent: vi.fn(async () => {
        // The consult writes into the session workspace, as a review that
        // records its findings (or applies a fix) does.
        fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex findings");
        // …and the launching turn finishes first — the whole reason the agent
        // was told to background it.
        if (opts.turnEndsDuringConsult) runner.running = false;
        return { status: "success" as const, text: "done", truncated: false, durationMs: 1_100_000, costUsd: 0 };
      }),
    };
    const deps = {
      sessionManager: { get: () => ({ id: "s1", kind: "repo", agentId: "claude", agentPinned: true }), list: () => [] },
      credentialStore: { getEnableSubAgents: () => true, getAgentSubAgentDefaults: () => ({}) },
      agentRegistry: { refreshAuth: vi.fn(), get: () => ({ name: "Codex", installed: true, authConfigured: true }) },
      runnerRegistry: { get: () => runner },
      usageManager: { record: vi.fn(), getSessionUsage: () => null, getSessionTokenTotals: () => null },
      chatHistoryManager: { replaceInProgress: vi.fn(), append: vi.fn(), updateSubAgentConsultCard: vi.fn(() => true) },
      createGitManager: (dir: string) => new GitManager(dir),
    } as never;
    return { runner, deps, schedulePostTurnPush };
  }

  it("commits and pushes the consult's work once its turn is over", async () => {
    const { deps, schedulePostTurnPush } = scenario({ turnEndsDuringConsult: true });

    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

    const log = await git.log();
    expect(log[0].message).toContain("Sub-agent consult (codex)");
    expect(schedulePostTurnPush).toHaveBeenCalledTimes(1);
    // docs/218 — the reset gate requires a clean tree; a dirty one left by a
    // finished consult is what stranded the merged session in the incident.
    expect(await git.isClean()).toBe(true);
  });

  it("leaves the work to the ordinary post-turn commit while the turn is still running", async () => {
    const { deps, schedulePostTurnPush } = scenario({ turnEndsDuringConsult: false });

    await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

    expect((await git.log()).length).toBe(2); // init + the turn's commit
    expect(schedulePostTurnPush).not.toHaveBeenCalled();
    expect(await git.isClean()).toBe(false);
  });

  it("still delivers the consult's result when the commit path fails", async () => {
    const { deps } = scenario({ turnEndsDuringConsult: true });
    // A workspace that isn't a git repo at all — `autoCommit` throws.
    (deps as unknown as { createGitManager: (d: string) => GitManager }).createGitManager = () =>
      new GitManager(fs.mkdtempSync(path.join(os.tmpdir(), "shipit-not-a-repo-")));

    const res = await runSubAgent(deps, "s1", { subAgentId: "codex", prompt: "review", depth: 0 });

    expect(res.status).toBe("success");
    expect(res.text).toBe("done");
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
