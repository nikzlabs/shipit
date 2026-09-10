import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getSubAgentResult,
  runSubAgent,
  sweepSubAgentCredentialsOnSignOut,
  waitForSubAgentResult,
  teardownConsultDetail,
  SUB_AGENT_PER_TURN_CAP,
  HOST_SHUTDOWN_CONSULT_DETAIL,
} from "./sub-agent.js";
import { ServiceError } from "./types.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { ChatHistoryManager } from "../chat-history.js";
import { persistTurnInProgress } from "../chat-card-persistence.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import type { SubAgentConsultCard, SubAgentSpawnTarget } from "../../shared/types.js";
import type { ConsultResultDeliveryRequest } from "./consult-result-delivery.js";
import type * as InstalledHarnesses from "../../shared/installed-harnesses.js";
import { SUB_AGENT_TRANSPORT_TIMEOUT_MS } from "../../shared/sub-agent-run.js";
import { WorkerAbortedError, WorkerTimeoutError } from "../worker-http.js";
import { credentialRouteEnvName } from "../../shared/types/domain-types/credential-route.js";
import type { AccountSelection } from "../provider-account-manager.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import {
  clearSubtreeBorrows,
  perSessionCredentialsDir,
  provisionSubAgentCredentials,
  readSessionAccountMarker,
  subAgentSpawnHomeDir,
  writeSessionAccountMarker,
} from "../session-credentials.js";

interface FakeSession {
  id: string;
  agentId?: string;
  agentPinned?: boolean;
  serviceId?: string;
  billingMode?: "sub" | "key";
  model?: string;
}

function explicit(
  subAgentId: "codex" | "claude",
  over: Partial<Extract<SubAgentSpawnTarget, { kind: "explicit" }>> = {},
): SubAgentSpawnTarget {
  const claude = {
    serviceId: "anthropic",
    billingMode: "sub" as const,
    modelId: "claude-opus-5",
    reasoningEffort: "high",
  };
  const codex = {
    serviceId: "openai",
    billingMode: "sub" as const,
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
  };
  return {
    kind: "explicit",
    harnessId: subAgentId,
    ...(subAgentId === "claude" ? claude : codex),
    ...over,
  };
}

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
  hasRunnableModels?: boolean;
  agentKnown?: boolean;
  subAgentSpawnsThisTurn?: number;
  spawnResult?: SubAgentRunResult;
  spawnResults?: SubAgentRunResult[];
  runnerPresent?: boolean;
  credentialRoutes?: { id: string; serviceId: string; billingMode: "sub" | "key"; via: string; status: string; priority: number; isPrimary: boolean; label: string; createdAt: number; updatedAt: number; exhaustedUntil?: number; exhaustedAt?: number }[];
  rolePrompt?: string;
  eligibleModels?: { serviceId: string; serviceName: string; billingMode: string; modelId: string; label: string }[];
  credentialsDir?: string;
  containerRunner?: boolean;
}) {
  const session: FakeSession | null =
    opts.session === undefined ? { id: "s1", agentId: "claude", agentPinned: true } : opts.session;
  const emitMessage = vi.fn();
  const record = vi.fn();
  const reviewerRole = {
    name: "reviewer",
    params: { kind: "auto" as const },
    ...(opts.rolePrompt ? { prompt: opts.rolePrompt } : {}),
  };
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
  const updateSubAgentConsultCard = vi.fn(() => true);
  const append = vi.fn();
  const runner = {
    subAgentSpawnsThisTurn: opts.subAgentSpawnsThisTurn ?? 0,
    appliedSpawnIdentity: undefined as string | undefined,
    running: true,
    emitMessage,
    chatMessageGroups: [] as never[],
    steeredMessages: [] as never[],
    recordedCards: [] as never[],
    // Own properties shadow container accessors that require the absent this.turn.
    committedBodyIds: undefined,
    getTurnEventBuffer: () => [] as never[],
    lastPersistedBufferIndex: 0,
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
  if (opts.containerRunner) Object.setPrototypeOf(runner, ContainerSessionRunner.prototype);
  const selectAccountForTurn = vi.fn((_provider: string, selectOpts?: { exclude?: string[] }): AccountSelection => ({
    ok: true as const,
    route: { kind: "account" as const, id: selectOpts?.exclude?.length ? "acct-secondary" : "acct-primary" },
  }));
  const markAccountExhausted = vi.fn();
  const credentialRouteRows = (opts.credentialRoutes ?? []).map((r) => ({ ...r }));
  const markCredentialRouteExhausted = vi.fn((routeId: string, until: number) => {
    const row = credentialRouteRows.find((r) => r.id === routeId);
    if (row?.billingMode !== "sub") return null;
    row.exhaustedUntil = until;
    row.exhaustedAt = Date.now();
    return { ...row };
  });
  const deps = {
    sessionManager: {
      get: vi.fn((id: string) => (session?.id === id ? session : undefined)),
      list: vi.fn(() => opts.sessions ?? []),
    } as never,
    credentialStore: {
      getEnableSubAgents: () => opts.enableSubAgents ?? true,
      getCredentialRoute: (routeId: string) =>
        credentialRouteRows.find((r) => r.id === routeId)
        ?? (routeId.startsWith("acct-") ? { id: routeId, serviceId: "openai" } : undefined),
      markCredentialRouteExhausted,
      getFailoverCutoffs: () => ({ session: 90, weekly: 90 }),
      getReviewerPin: () => undefined,
      getRoles: () => [reviewerRole],
      getRole: (name: string) => (name === "reviewer" ? reviewerRole : undefined),
      listCredentialRoutes: (serviceId?: string, billingMode?: string) =>
        credentialRouteRows.filter(
          (r) =>
            (serviceId === undefined || r.serviceId === serviceId)
            && (billingMode === undefined || r.billingMode === billingMode),
        ),
      getCredentialSecret: () => "sk-test",
      getSelectionMode: () => "strict" as const,
    } as never,
    agentRegistry: {
      refreshAuth: vi.fn(),
      get: vi.fn(() => (opts.agentKnown === false
        ? undefined
        : {
            name: "Codex",
            installed: true,
            hasRunnableModels: opts.hasRunnableModels ?? true,
            eligibleModels: opts.eligibleModels ?? [
              {
                serviceId: "openai",
                serviceName: "OpenAI",
                billingMode: "sub",
                modelId: "gpt-5.6-sol",
                label: "GPT-5.6 Sol",
              },
              {
                serviceId: "openai",
                serviceName: "OpenAI",
                billingMode: "sub",
                modelId: "gpt-5.6-terra",
                label: "GPT-5.6 Terra",
              },
              {
                serviceId: "anthropic",
                serviceName: "Anthropic",
                billingMode: "key",
                modelId: "claude-opus-5",
                label: "Opus 5",
              },
              {
                serviceId: "anthropic",
                serviceName: "Anthropic",
                billingMode: "sub",
                modelId: "claude-opus-5",
                label: "Opus 5",
              },
            ],
          })),
    } as never,
    runnerRegistry: { get: vi.fn(() => (opts.runnerPresent === false ? undefined : runner)) } as never,
    providerAccountManager: { selectAccountForTurn, markAccountExhausted, subscriptionLimitsFor: vi.fn(() => ({})) } as never,
    usageManager: { record, getSessionUsage, getSessionTokenTotals } as never,
    recordAgentRateLimits,
    chatHistoryManager: { replaceInProgress, append, updateSubAgentConsultCard } as never,
    ...(opts.credentialsDir !== undefined ? { credentialsDir: opts.credentialsDir } : {}),
  };
  return {
    deps, runner, emitMessage, record, replaceInProgress, append, updateSubAgentConsultCard,
    recordAgentRateLimits, selectAccountForTurn, markAccountExhausted, markCredentialRouteExhausted,
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
    await expectServiceError(runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 }), 403);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects an unknown agent (400)", async () => {
    const { deps } = makeDeps({ agentKnown: false });
    await expectServiceError(runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 }), 400);
  });

  it("rejects a harness this deployment did not install (400)", async () => {
    uninstalledHarnesses.add("codex");
    const { deps, runner } = makeDeps({});
    const err = await expectServiceError(
      runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 }), 400);
    expect(err.message).toMatch(/not installed in this deployment/);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects an unauthed agent (400)", async () => {
    const { deps } = makeDeps({ hasRunnableModels: false });
    await expectServiceError(runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 }), 400);
  });

  it("rejects a pre-pin session (409)", async () => {
    const { deps } = makeDeps({ session: { id: "s1", agentId: "claude", agentPinned: false } });
    await expectServiceError(runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 }), 409);
  });

  it("rejects a non-zero depth — recursion guard (403)", async () => {
    const { deps, runner } = makeDeps({});
    await expectServiceError(runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 1 }), 403);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects past the per-turn cap (429) without spawning", async () => {
    const { deps, runner } = makeDeps({ subAgentSpawnsThisTurn: SUB_AGENT_PER_TURN_CAP });
    await expectServiceError(runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 }), 429);
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt (400)", async () => {
    const { deps } = makeDeps({});
    await expectServiceError(runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "   ", depth: 0 }), 400);
  });

  it("rejects an explicit selection the named harness cannot run (400)", async () => {
    const { deps, runner } = makeDeps({});
    const err = await expectServiceError(
      runSubAgent(deps, "s1", {
        target: explicit("claude", {
          serviceId: "openai",
          billingMode: "sub",
          modelId: "gpt-5.6-sol",
        }),
        prompt: "review",
        depth: 0,
      }),
      400,
    );
    expect(err.message).toContain("cannot run");
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("does not spend a cap slot on a refused call", async () => {
    const { deps, runner } = makeDeps({});
    for (let i = 0; i < SUB_AGENT_PER_TURN_CAP; i++) {
      await expectServiceError(
        runSubAgent(deps, "s1", {
          target: explicit("claude", { modelId: "gpt-5.6-luna" }),
          prompt: "review",
          depth: 0,
        }),
        400,
      );
    }
    expect(runner.subAgentSpawnsThisTurn).toBe(0);
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses a recursive role call for recursion, not for an unresolvable reviewer", async () => {
    const { deps } = makeDeps({ credentialRoutes: [] });
    await expectServiceError(
      runSubAgent(deps, "s1", { target: { kind: "role", role: "reviewer", overrides: {} }, prompt: "review", depth: 1 }),
      403,
    );
  });

  it("refuses a capped role call for the cap, not for an unresolvable reviewer", async () => {
    const { deps } = makeDeps({ credentialRoutes: [], subAgentSpawnsThisTurn: SUB_AGENT_PER_TURN_CAP });
    await expectServiceError(
      runSubAgent(deps, "s1", { target: { kind: "role", role: "reviewer", overrides: {} }, prompt: "review", depth: 0 }),
      429,
    );
  });
});

describe("runSubAgent — --role reviewer", () => {
  const keyRoute = (serviceId: string) => ({
    id: `${serviceId}-key`,
    serviceId,
    billingMode: "key" as const,
    via: "string",
    status: "ready",
    priority: 0,
    isPrimary: true,
    label: "test",
    createdAt: 0,
    updatedAt: 0,
  });

  it("spawns on the reviewer furthest from the implementer, at the reviewer's level", async () => {
    const { deps, runner } = makeDeps({
      session: { id: "s1", agentId: "claude", agentPinned: true },
      credentialRoutes: [keyRoute("openai"), keyRoute("anthropic")],
    });
    await runSubAgent(deps, "s1", { target: { kind: "role", role: "reviewer", overrides: {} }, prompt: "review", depth: 0 });
    const arg = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } })
      .mock.calls[0][0];
    expect(arg.agentId).toBe("codex");
    expect(arg.model).toBe("gpt-5.6-sol");
    expect(arg.reasoningEffort).toBeTruthy();
    expect(arg.serviceRouting).toBeDefined();
  });

  it("persists the resolved reviewer on the consult card, matching the spawn and the bill", async () => {
    const { deps, runner, emitMessage, record } = makeDeps({
      session: { id: "s1", agentId: "claude", agentPinned: true },
      credentialRoutes: [keyRoute("openai"), keyRoute("anthropic")],
    });
    await runSubAgent(deps, "s1", { target: { kind: "role", role: "reviewer", overrides: {} }, prompt: "review", depth: 0 });

    const arg = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } })
      .mock.calls[0][0];
    const cards = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: Record<string, unknown> })
      .filter((m) => m.type === "sub_agent_consult_card")
      .map((m) => m.card!);

    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.subAgentId).toBe(arg.agentId);
      expect(card.runOn).toEqual({
        serviceId: "openai",
        billingMode: "key",
        modelId: arg.model,
        reasoningEffort: arg.reasoningEffort,
      });
    }
    expect(record.mock.calls[0][5]).toMatchObject({ model: arg.model });
  });

  it("records the ROLE on the consult card, beside what it resolved to", async () => {
    const { deps, emitMessage } = makeDeps({
      session: { id: "s1", agentId: "claude", agentPinned: true },
      credentialRoutes: [keyRoute("openai"), keyRoute("anthropic")],
    });
    await runSubAgent(deps, "s1", { target: { kind: "role", role: "reviewer", overrides: {} }, prompt: "review", depth: 0 });
    const cards = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: Record<string, unknown> })
      .filter((m) => m.type === "sub_agent_consult_card")
      .map((m) => m.card!);
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(card.roleName).toBe("reviewer");
  });

  it("leaves the role off the card when the caller named all five parameters", async () => {
    const { deps, emitMessage } = makeDeps({});
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "go", depth: 0 });
    const card = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: Record<string, unknown> })
      .filter((m) => m.type === "sub_agent_consult_card")
      .map((m) => m.card)[0];
    expect(card).toBeDefined();
    expect(card?.roleName).toBeUndefined();
  });

  it("joins the role's standing instructions onto the prompt it spawns with", async () => {
    const { deps, runner } = makeDeps({
      credentialRoutes: [keyRoute("openai"), keyRoute("anthropic")],
      rolePrompt: "Check the diff against requirements.md.",
    });
    await runSubAgent(deps, "s1", {
      target: { kind: "role", role: "reviewer", overrides: {} },
      prompt: "Review PR 12.",
      depth: 0,
    });
    const arg = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } })
      .mock.calls[0][0];
    expect(arg.prompt).toContain("Check the diff against requirements.md.");
    expect(arg.prompt).toContain("Review PR 12.");
    expect(arg.prompt).toContain("Standing instructions");
  });

  it("passes the task through untouched when the role carries no instructions", async () => {
    const { deps, runner } = makeDeps({
      credentialRoutes: [keyRoute("openai"), keyRoute("anthropic")],
    });
    await runSubAgent(deps, "s1", {
      target: { kind: "role", role: "reviewer", overrides: {} },
      prompt: "Review PR 12.",
      depth: 0,
    });
    const arg = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } })
      .mock.calls[0][0];
    expect(arg.prompt).toBe("Review PR 12.");
  });

  it("sends a Codex session's work the other way, with nothing reconfigured", async () => {
    const { deps, runner } = makeDeps({
      session: { id: "s1", agentId: "codex", agentPinned: true },
      credentialRoutes: [keyRoute("openai"), keyRoute("anthropic")],
    });
    await runSubAgent(deps, "s1", { target: { kind: "role", role: "reviewer", overrides: {} }, prompt: "review", depth: 0 });
    const arg = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } })
      .mock.calls[0][0];
    expect(arg.agentId).toBe("claude");
  });

  it("ranks against the resident process's stamp, not a row changed mid-turn", async () => {
    const { deps, runner } = makeDeps({
      session: {
        id: "s1",
        agentId: "claude",
        agentPinned: true,
        serviceId: "anthropic",
        billingMode: "key",
        model: "claude-opus-5",
      },
      credentialRoutes: [keyRoute("anthropic"), keyRoute("deepseek")],
    });
    runner.appliedSpawnIdentity = "claude|deepseek|key|deepseek-flash|anthropic-messages|https://x";
    await runSubAgent(deps, "s1", { target: { kind: "role", role: "reviewer", overrides: {} }, prompt: "review", depth: 0 });
    const arg = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } })
      .mock.calls[0][0];
    expect(arg.model).toBe("claude-opus-5");
  });

  it("refuses when no configured reviewer has a usable credential", async () => {
    const { deps, runner } = makeDeps({ credentialRoutes: [] });
    const err = await expectServiceError(
      runSubAgent(deps, "s1", { target: { kind: "role", role: "reviewer", overrides: {} }, prompt: "review", depth: 0 }),
      400,
    );
    expect(err.message).toContain('role "reviewer" cannot run');
    expect(err.message).toContain("Connect a service in Settings");
    expect(runner.spawnSubAgent).not.toHaveBeenCalled();
  });

  it("still honours the global gate", async () => {
    const { deps } = makeDeps({
      enableSubAgents: false,
      credentialRoutes: [keyRoute("openai"), keyRoute("anthropic")],
    });
    await expectServiceError(
      runSubAgent(deps, "s1", { target: { kind: "role", role: "reviewer", overrides: {} }, prompt: "review", depth: 0 }),
      403,
    );
  });
});

describe("runSubAgent — happy path", () => {
  const glmPlanCredential = (id: string, priority: number) => ({
    id,
    serviceId: "zai",
    billingMode: "sub" as const,
    via: "string",
    status: "ready",
    priority,
    isPrimary: priority === 0,
    label: id,
    createdAt: 0,
    updatedAt: 0,
  });

  it("spawns, returns text, increments the per-turn counter, records usage, emits spinner + persisted consult card", async () => {
    const { deps, runner, emitMessage, record, replaceInProgress } = makeDeps({});
    const res = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review this", depth: 0 });

    expect(res.text).toBe("2 bugs found");
    expect(res.subAgentId).toBe("codex");
    expect(runner.subAgentSpawnsThisTurn).toBe(1);
    expect(runner.spawnSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "codex", prompt: "review this", depth: 0 }),
    );
    expect(record).toHaveBeenCalledWith("s1", 0, 4200, 1000, 200, {
      subAgentId: "codex",
      costSource: "per-turn",
      model: "gpt-5.6-sol",
      attribution: expect.objectContaining({ serviceId: "openai", billingMode: "sub" }),
      contextTokens: 1200,
    });
    const msgs = emitMessage.mock.calls.map((c) => c[0] as { type: string });
    expect(msgs[0]).toMatchObject({ type: "sub_agent_spawn", sessionId: "s1", subAgentId: "codex" });
    expect(msgs[1]).toMatchObject({
      type: "sub_agent_consult_card",
      card: expect.objectContaining({
        subAgentId: "codex",
        status: "pending",
        runOn: {
          serviceId: "openai",
          billingMode: "sub",
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      }),
    });
    expect(msgs[2]).toMatchObject({
      type: "usage_update",
      sessionId: "s1",
      subAgent: true,
      cumulativeInputTokens: 1000,
      cumulativeOutputTokens: 200,
    });
    expect(msgs[3]).toMatchObject({
      type: "sub_agent_consult_card",
      card: expect.objectContaining({
        subAgentId: "codex",
        status: "success",
        durationMs: 4200,
        costUsd: 0.03,
        outputMarkdown: "2 bugs found",
        runOn: expect.objectContaining({ modelId: "gpt-5.6-sol" }),
      }),
    });
    expect((msgs[3] as unknown as { card: { spawnId: string } }).card.spawnId).toBe(
      (msgs[0] as unknown as { spawnId: string }).spawnId,
    );
    expect((msgs[3] as unknown as { card: { cardId: string } }).card.cardId).toBe(
      (msgs[1] as unknown as { card: { cardId: string } }).card.cardId,
    );
    expect(replaceInProgress).toHaveBeenCalled();
  });

  it("returns the caller the SAME text it puts on the card, under one run id (planning#247)", async () => {
    const { deps, emitMessage } = makeDeps({
      spawnResult: {
        status: "success",
        text: "The plan is viable, but…\n\nI found nine definite problems.",
        truncated: false,
        durationMs: 1102_000,
        costUsd: 0,
      },
    });
    const res = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    const card = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { spawnId: string; outputMarkdown?: string } })
      .filter((m) => m.type === "sub_agent_consult_card")
      .at(-1)?.card;
    expect(card?.outputMarkdown).toBe(res.text);
    expect(res.spawnId).toBe(card?.spawnId);
  });

  it("emits a long consult as its preview line while persisting the whole output (docs/244, planning#299)", async () => {
    const review = Array.from({ length: 300 }, (_, i) => `finding ${i}`).join("\n");
    const { deps, emitMessage, replaceInProgress } = makeDeps({
      spawnResult: { status: "success", text: review, truncated: false, durationMs: 900_000, costUsd: 0 },
    });

    const res = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    const emitted = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { outputMarkdown?: string; outputTruncated?: true } })
      .filter((m) => m.type === "sub_agent_consult_card")
      .at(-1)?.card;
    expect(emitted?.outputTruncated).toBe(true);
    expect(emitted?.outputMarkdown).not.toContain("finding 299");

    expect(res.text).toBe(review);
    const persistedCard = replaceInProgress.mock.calls
      .map((c) => c[1] as { subAgentConsult?: { outputMarkdown?: string; outputTruncated?: true } }[])
      .at(-1)
      ?.find((m) => m.subAgentConsult);
    expect(persistedCard?.subAgentConsult?.outputMarkdown).toBe(review);
    expect(persistedCard?.subAgentConsult?.outputTruncated).toBeUndefined();
  });

  it("forwards the explicitly named model and effort to the spawn", async () => {
    const { deps, runner } = makeDeps({});
    await runSubAgent(deps, "s1", {
      target: explicit("codex", { modelId: "gpt-5.6-terra", reasoningEffort: "low" }),
      prompt: "review",
      depth: 0,
    });
    expect(runner.spawnSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "codex", reasoningEffort: "low", model: "gpt-5.6-terra" }),
    );
  });

  it("always passes a model and an effort — there is no unset default left", async () => {
    const { deps, runner } = makeDeps({});
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    const calls = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } }).mock.calls;
    const arg = calls[0][0];
    expect(arg.reasoningEffort).toBe("high");
    expect(arg.model).toBe("gpt-5.6-sol");
  });

  it("spawns a complete target on a no-levels harness with the effort key absent (docs/275)", async () => {
    const { deps, runner } = makeDeps({
      eligibleModels: [{
        serviceId: "xai", serviceName: "xAI", billingMode: "key",
        modelId: "grok-4.6", label: "Grok 4.6",
      }],
      credentialRoutes: [{
        id: "xai-key", serviceId: "xai", billingMode: "key", via: "string",
        status: "ready", priority: 0, isPrimary: true, label: "test", createdAt: 0, updatedAt: 0,
      }],
    });
    const res = await runSubAgent(deps, "s1", {
      target: {
        kind: "explicit",
        harnessId: "grok",
        serviceId: "xai",
        billingMode: "key",
        modelId: "grok-4.6",
      },
      prompt: "review",
      depth: 0,
    });
    expect(res.status).toBe("success");
    const arg = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } })
      .mock.calls[0][0];
    expect(arg.agentId).toBe("grok");
    expect(arg.model).toBe("grok-4.6");
    expect("reasoningEffort" in arg).toBe(false);
  });

  it("carries the named service and billing mode into the spawn and the attribution", async () => {
    const { deps, runner, record } = makeDeps({
      credentialRoutes: [{
        id: "anthropic-key", serviceId: "anthropic", billingMode: "key", via: "string",
        status: "ready", priority: 0, isPrimary: true, label: "test", createdAt: 0, updatedAt: 0,
      }],
    });
    await runSubAgent(deps, "s1", {
      target: explicit("claude", {
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
      }),
      prompt: "review",
      depth: 0,
    });
    const arg = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } })
      .mock.calls[0][0];
    expect(arg.model).toBe("claude-opus-5");
    expect(record).toHaveBeenCalledWith("s1", expect.anything(), 4200, 1000, 200,
      expect.objectContaining({
        model: "claude-opus-5",
        attribution: expect.objectContaining({ serviceId: "anthropic", billingMode: "key" }),
      }));
  });

  it("forwards a carried-back rate-limit snapshot into the sub-agent's limits provider", async () => {
    const rateLimits = {
      session: { usedPct: 55, resetAt: "2026-06-13T05:00:00Z" },
      weekly: { usedPct: 12, resetAt: "2026-06-20T00:00:00Z" },
    };
    const { deps, recordAgentRateLimits } = makeDeps({
      spawnResult: { status: "success", text: "ok", truncated: false, durationMs: 1000, costUsd: 0, rateLimits },
    });
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    const call = recordAgentRateLimits.mock.calls[0];
    expect(call.slice(0, 4)).toEqual(["codex", rateLimits.session, rateLimits.weekly, "s1"]);
    expect(call).toHaveLength(5);
  });

  it("does not touch the limits provider when the consult pushed no rate-limit snapshot", async () => {
    const { deps, recordAgentRateLimits } = makeDeps({
      spawnResult: { status: "success", text: "ok", truncated: false, durationMs: 1000, costUsd: 0 },
    });
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    expect(recordAgentRateLimits).not.toHaveBeenCalled();
  });

  it("selects a healthy subscription account proactively for a one-shot run", async () => {
    const { deps, runner, selectAccountForTurn } = makeDeps({});
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    expect(selectAccountForTurn).toHaveBeenCalledTimes(1);
    const [service, selectOpts] = selectAccountForTurn.mock.calls[0] as [
      string,
      { optimistic?: boolean } | undefined,
    ];
    expect(service).toBe("openai");
    expect(selectOpts?.optimistic).toBeUndefined();
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
    const result = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    expect(markAccountExhausted).toHaveBeenCalledWith("openai", "acct-primary", Date.parse(resetAt));
    expect(selectAccountForTurn).toHaveBeenLastCalledWith("openai", { exclude: ["acct-primary"] });
    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("review complete");
  });

  it("benches and retries when the limit arrives as the run's final text on a success", async () => {
    const { deps, runner, markAccountExhausted } = makeDeps({
      spawnResults: [
        { status: "success", text: "You've hit your session limit · resets 5:10pm (UTC)", truncated: false, durationMs: 10, costUsd: 0 },
        { status: "success", text: "review complete", truncated: false, durationMs: 20, costUsd: 0 },
      ],
    });
    const result = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
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

    const result = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(3);
    expect(markAccountExhausted).toHaveBeenCalledTimes(2);
    expect(selectAccountForTurn).toHaveBeenNthCalledWith(3, "openai", {
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

    const result = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("error");
    expect(result.error).toBe(
      "Every connected Codex subscription account is out of quota. Earliest reset: 2099-08-02T11:00:00.000Z.",
    );
  });

  it("fails the consult when the last account's limit arrived as final text", async () => {
    const earliestResetAt = "2099-08-02T11:00:00.000Z";
    const { deps, runner, selectAccountForTurn } = makeDeps({
      spawnResult: { status: "success", text: "You've hit your session limit · resets 5:10pm (UTC)", truncated: false, durationMs: 10, costUsd: 0 },
    });
    selectAccountForTurn
      .mockReturnValueOnce({ ok: true, route: { kind: "account", id: "acct-primary" } })
      .mockReturnValueOnce({ ok: false, reason: "all_exhausted", earliestResetAt });

    const result = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("error");
    expect(result.error).toContain("out of quota");
  });

  it("does not read the text channel when the run carries a non-quota error", async () => {
    const { deps, runner, markAccountExhausted } = makeDeps({
      spawnResult: { status: "error", text: "You've hit your session limit · resets 5:10pm (UTC)", error: "This account cannot access model opus", truncated: false, durationMs: 10, costUsd: 0 },
    });
    const result = await runSubAgent(deps, "s1", { target: explicit("claude"), prompt: "review", depth: 0 });
    expect(result.status).toBe("error");
    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(1);
    expect(markAccountExhausted).not.toHaveBeenCalled();
  });

  it("does not retry a model-access error", async () => {
    const { deps, runner, markAccountExhausted } = makeDeps({
      spawnResult: { status: "error", text: "", error: "This account cannot access model opus", truncated: false, durationMs: 10, costUsd: 0 },
    });
    const result = await runSubAgent(deps, "s1", { target: explicit("claude"), prompt: "review", depth: 0 });
    expect(result.status).toBe("error");
    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(1);
    expect(markAccountExhausted).not.toHaveBeenCalled();
  });

  it("benches a hard-exhausted string credential and retries on the next in the group", async () => {
    const resetAt = "2099-08-02T12:00:00.000Z";
    const { deps, runner, markCredentialRouteExhausted, markAccountExhausted } = makeDeps({
      spawnResults: [
        { status: "error", text: "", error: `Weekly usage limit reached. It resets at ${resetAt}.`, truncated: false, durationMs: 10, costUsd: 0 },
        { status: "success", text: "review complete", truncated: false, durationMs: 20, costUsd: 0 },
      ],
      credentialRoutes: [glmPlanCredential("cred-glm-a", 0), glmPlanCredential("cred-glm-b", 1)],
      eligibleModels: [
        { serviceId: "zai", serviceName: "GLM (Z.ai)", billingMode: "sub", modelId: "glm-5.3[1m]", label: "GLM-5.3" },
      ],
    });
    const target: SubAgentSpawnTarget = explicit("claude", {
      serviceId: "zai",
      billingMode: "sub",
      modelId: "glm-5.3[1m]",
    });
    const result = await runSubAgent(deps, "s1", { target, prompt: "review", depth: 0 });

    expect(markCredentialRouteExhausted).toHaveBeenCalledWith("cred-glm-a", Date.parse(resetAt));
    expect(markAccountExhausted).not.toHaveBeenCalled();
    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("review complete");
    const calls = (runner.spawnSubAgent as unknown as { mock: { calls: Record<string, unknown>[][] } })
      .mock.calls;
    expect(calls[0][0].serviceRouting).toMatchObject({
      credentialSourceEnv: credentialRouteEnvName("cred-glm-a"),
    });
    expect(calls[1][0].serviceRouting).toMatchObject({
      credentialSourceEnv: credentialRouteEnvName("cred-glm-b"),
    });
  });

  it("gives up cleanly after every string credential in the group is exhausted", async () => {
    const { deps, runner, markCredentialRouteExhausted } = makeDeps({
      spawnResults: [
        { status: "error", text: "", error: "Weekly usage limit reached. It resets at 2099-08-02T12:00:00.000Z.", truncated: false, durationMs: 10, costUsd: 0 },
        { status: "error", text: "", error: "Quota exhausted", truncated: false, durationMs: 10, costUsd: 0 },
      ],
      credentialRoutes: [glmPlanCredential("cred-glm-a", 0), glmPlanCredential("cred-glm-b", 1)],
      eligibleModels: [
        { serviceId: "zai", serviceName: "GLM (Z.ai)", billingMode: "sub", modelId: "glm-5.3[1m]", label: "GLM-5.3" },
      ],
    });
    const target: SubAgentSpawnTarget = explicit("claude", {
      serviceId: "zai",
      billingMode: "sub",
      modelId: "glm-5.3[1m]",
    });
    const result = await runSubAgent(deps, "s1", { target, prompt: "review", depth: 0 });

    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(2);
    expect(markCredentialRouteExhausted).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("error");
    expect(result.error).toContain("out of quota");
  });

  it("does not fail over a metered key that reports exhaustion", async () => {
    const { deps, runner, markCredentialRouteExhausted } = makeDeps({
      spawnResult: { status: "error", text: "", error: "Quota exceeded", truncated: false, durationMs: 10, costUsd: 0 },
      credentialRoutes: [{
        id: "cred-glm-key", serviceId: "zai", billingMode: "key", via: "string",
        status: "ready", priority: 0, isPrimary: true, label: "test", createdAt: 0, updatedAt: 0,
      }],
      eligibleModels: [
        { serviceId: "zai", serviceName: "GLM (Z.ai)", billingMode: "key", modelId: "glm-5.2", label: "GLM-5.2" },
      ],
    });
    const target: SubAgentSpawnTarget = explicit("claude", {
      serviceId: "zai",
      billingMode: "key",
      modelId: "glm-5.2",
    });
    const result = await runSubAgent(deps, "s1", { target, prompt: "review", depth: 0 });

    expect(runner.spawnSubAgent).toHaveBeenCalledTimes(1);
    expect(markCredentialRouteExhausted).toHaveBeenCalledWith("cred-glm-key", expect.any(Number));
    expect(result.status).toBe("error");
    expect(result.error).toBe("Quota exceeded");
  });

  it("omits outputMarkdown when the sub-agent returned empty text (docs/220)", async () => {
    const { deps, emitMessage } = makeDeps({
      spawnResult: { status: "success", text: "", truncated: false, durationMs: 1000, costUsd: 0 },
    });
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    const card = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { outputMarkdown?: string } })
      .filter((m) => m.type === "sub_agent_consult_card")
      .at(-1)?.card;
    expect(card?.outputMarkdown).toBeUndefined();
  });

  it("gives each brokered call its own card id — one card per run, patched in place", async () => {
    const { deps, emitMessage } = makeDeps({});
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "re-review", depth: 0 });
    const cardIds = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { cardId?: string } })
      .filter((m) => m.type === "sub_agent_consult_card")
      .map((m) => m.card?.cardId);
    expect(cardIds).toHaveLength(4);
    expect(new Set(cardIds).size).toBe(2);
    expect(cardIds[0]).toBe(cardIds[1]);
    expect(cardIds[2]).toBe(cardIds[3]);
    expect(cardIds[0]).not.toBe(cardIds[2]);
  });

  it("finalizes the pending card as an error when the spawn throws (never left pending)", async () => {
    const { deps, runner, emitMessage, updateSubAgentConsultCard } = makeDeps({});
    runner.spawnSubAgent = vi.fn(async () => {
      runner.running = false;
      throw new Error("worker unreachable");
    });
    await expect(runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 })).rejects.toThrow(
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
    expect((msgs[2] as unknown as { card: { outputMarkdown?: string } }).card.outputMarkdown).toBeUndefined();
    expect(updateSubAgentConsultCard).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({ status: "error" }),
    );
  });

  it("allows a same-provider spawn (no extra credentials needed)", async () => {
    const { deps, runner } = makeDeps({ session: { id: "s1", agentId: "claude", agentPinned: true } });
    const res = await runSubAgent(deps, "s1", { target: explicit("claude"), prompt: "draft tests", depth: 0 });
    expect(res.status).toBe("success");
    expect(runner.spawnSubAgent).toHaveBeenCalled();
  });

  it("counts the spawn against the budget up to the cap across calls", async () => {
    const { deps, runner } = makeDeps({});
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "a", depth: 0 });
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "b", depth: 0 });
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "c", depth: 0 });
    expect(runner.subAgentSpawnsThisTurn).toBe(3);
    await expectServiceError(runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "d", depth: 0 }), 429);
  });
});

describe("runSubAgent — durable in-flight consult card", () => {
  it("persists a pending card at spawn time, before the run finishes", async () => {
    let cardAtSpawn: { status: string } | undefined;
    const { deps, runner, replaceInProgress } = makeDeps({});
    runner.spawnSubAgent = vi.fn(async () => {
      cardAtSpawn = (runner.recordedCards as unknown as { message: { subAgentConsult: { status: string } } }[])
        .at(-1)?.message.subAgentConsult;
      expect(replaceInProgress).toHaveBeenCalled();
      return { status: "success", text: "done", truncated: false, durationMs: 10, costUsd: 0 };
    });
    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    expect(cardAtSpawn).toMatchObject({ status: "pending" });
  });

  it("patches the finalized DB row when the originating turn already ended", async () => {
    const { deps, runner, updateSubAgentConsultCard, replaceInProgress } = makeDeps({});
    let persistsAtSpawn = 0;
    runner.spawnSubAgent = vi.fn(async () => {
      persistsAtSpawn = replaceInProgress.mock.calls.length;
      (runner as unknown as { running: boolean }).running = false;
      runner.recordedCards = [] as never[];
      return { status: "success", text: "9 findings", truncated: false, durationMs: 900_000, costUsd: 0 };
    });

    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(updateSubAgentConsultCard).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({ status: "success", outputMarkdown: "9 findings" }),
    );
    expect(replaceInProgress.mock.calls.length).toBe(persistsAtSpawn);
  });

  it("lands a cancelled card through the LIVE runner when the original was disposed", async () => {
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
      (deps.runnerRegistry as unknown as { get: ReturnType<typeof vi.fn> }).get =
        vi.fn(() => liveRunner);
      throw new WorkerAbortedError("/agent/spawn", "runner disposed");
    });

    await expect(
      runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 }),
    ).rejects.toBeInstanceOf(WorkerAbortedError);

    expect(liveEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sub_agent_consult_card",
        card: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    const cancelledCard = liveEmit.mock.calls
      .map((c) => c[0] as { type: string; card?: { status?: string; statusDetail?: string } })
      .find((m) => m.type === "sub_agent_consult_card" && m.card?.status === "cancelled")!.card!;
    expect(cancelledCard.statusDetail).toBe(teardownConsultDetail("runner disposed"));
    expect(cancelledCard.statusDetail).toContain("torn down");
    expect(cancelledCard.statusDetail).toContain("runner disposed");
    const staleTerminal = emitMessage.mock.calls
      .map((c) => c[0] as { type: string; card?: { status?: string } })
      .filter((m) => m.type === "sub_agent_consult_card" && m.card?.status !== "pending");
    expect(staleTerminal).toHaveLength(0);
    expect(updateSubAgentConsultCard).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({
        status: "cancelled",
        statusDetail: teardownConsultDetail("runner disposed"),
      }),
    );
  });

  it("names the host shutdown when a cancelled result comes back from the run", async () => {
    const { deps, runner, updateSubAgentConsultCard } = makeDeps({});
    runner.spawnSubAgent = vi.fn(async () => {
      runner.running = false;
      return {
        status: "cancelled",
        text: "partial review",
        truncated: true,
        durationMs: 321_327,
        costUsd: 0,
      };
    }) as never;

    const res = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
    expect(res.status).toBe("cancelled");
    expect(updateSubAgentConsultCard).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({
        status: "cancelled",
        statusDetail: HOST_SHUTDOWN_CONSULT_DETAIL,
        outputMarkdown: "partial review",
      }),
    );
  });

  it("finalizes as a timeout when the transport backstop fires", async () => {
    const { deps, runner, updateSubAgentConsultCard } = makeDeps({});
    runner.spawnSubAgent = vi.fn(async () => {
      runner.running = false;
      throw new WorkerTimeoutError("/agent/spawn", SUB_AGENT_TRANSPORT_TIMEOUT_MS);
    });
    await expect(
      runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 }),
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

  const reader = (cards: SubAgentConsultCard[]) => ({
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

  describe("duplicate rows for one run (planning#402)", () => {
    const pendingCard = (spawnId: string) => ({ ...card(spawnId, ""), status: "pending" as const });

    it("prefers the terminal copy over an earlier pending duplicate, by id", () => {
      const found = getSubAgentResult(
        reader([pendingCard("aaa1"), card("aaa1", "the review")]),
        "s1",
        "aaa1",
      );
      expect(found).toMatchObject({ status: "success", outputMarkdown: "the review" });
    });

    it("prefers it on the no-id and prefix paths too", () => {
      const rows = [card("old0", "older run"), pendingCard("aaa1"), card("aaa1", "the review")];
      expect(getSubAgentResult(reader(rows), "s1")).toMatchObject({ outputMarkdown: "the review" });
      expect(getSubAgentResult(reader(rows), "s1", "aa")).toMatchObject({ outputMarkdown: "the review" });
    });

    it("still reports pending when that is all there is", () => {
      expect(getSubAgentResult(reader([pendingCard("aaa1")]), "s1", "aaa1").status).toBe("pending");
    });

    it("counts distinct runs, not rows, when judging a prefix ambiguous", () => {
      expect(getSubAgentResult(reader([pendingCard("aaa1"), card("aaa1", "x")]), "s1", "aaa").spawnId)
        .toBe("aaa1");
      expect(() => getSubAgentResult(reader([card("aaa1", "x"), card("aaa2", "y")]), "s1", "aaa"))
        .toThrow(ServiceError);
    });
  });
});

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
    const h = harness([
      [card("aaa1", "pending")],
      [],
      [card("aaa1", "success", "recovered")],
    ]);
    const res = await waitForSubAgentResult(h.deps, "s1", { segmentMs: 60_000, ...h.opts });
    expect(res.outcome).toBe("finished");
    expect(res.card.outputMarkdown).toBe("recovered");
  });
});

describe("a backgrounded consult that finishes AFTER its launching turn (planning#247)", () => {
  const OUTPUT = "## Findings\n\n- `foo.ts:42` — a real bug\n";
  const TURN_ONE_TEXT = "Launching a Codex review in the background…";

  function consultScenario(launch: "mid-turn" | "post-turn" | "foreground") {
    const dbManager = new DatabaseManager(":memory:");
    const chatHistoryManager = new ChatHistoryManager(dbManager);
    const finalizeTurnOne = () => {
      persistTurnInProgress(chatHistoryManager, runner as never, "s1");
      chatHistoryManager.finalizeInProgress("s1");
      runner.running = false;
    };
    const runner = {
      subAgentSpawnsThisTurn: 0,
      running: launch !== "post-turn",
      emitMessage: vi.fn(),
      chatMessageGroups: [{ text: TURN_ONE_TEXT, toolUse: [] }],
      steeredMessages: [],
      recordedCards: [],
      spawnSubAgent: vi.fn(async () => {
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
    if (launch === "post-turn") finalizeTurnOne();

    const deps = {
      sessionManager: { get: () => ({ id: "s1", agentId: "claude", agentPinned: true }), list: () => [] },
      credentialStore: { getEnableSubAgents: () => true },
      agentRegistry: { refreshAuth: vi.fn(), get: () => ({ name: "Codex", installed: true, hasRunnableModels: true }) },
      runnerRegistry: { get: () => runner },
      usageManager: { record: vi.fn(), getSessionUsage: () => null, getSessionTokenTotals: () => null },
      chatHistoryManager,
    } as never;
    return { dbManager, chatHistoryManager, runner, deps };
  }

  function startTurnTwo(chatHistoryManager: ChatHistoryManager, runner: Record<string, unknown>) {
    runner.chatMessageGroups = [];
    runner.recordedCards = [];
    runner.steeredMessages = [];
    runner.running = true;
    chatHistoryManager.append("s1", { role: "user", text: "what did it say?" });
    runner.chatMessageGroups = [{ text: "Reading the run's result…", toolUse: [{}] }];
    persistTurnInProgress(chatHistoryManager, runner as never, "s1");
  }

  for (const launch of ["mid-turn", "post-turn", "foreground"] as const) {
    describe(`launched ${launch}`, () => {
      it("is still re-readable by `shipit agent result <id>` a turn later", async () => {
        const { dbManager, chatHistoryManager, runner, deps } = consultScenario(launch);
        const res = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

        startTurnTwo(chatHistoryManager, runner as never);

        const byId = getSubAgentResult({ chatHistoryManager }, "s1", res.spawnId);
        expect(byId.outputMarkdown).toBe(OUTPUT);
        expect(getSubAgentResult({ chatHistoryManager }, "s1").spawnId).toBe(res.spawnId);
        dbManager.close();
      });

      it("is still in the transcript a session switch / full reload rehydrates from", async () => {
        const { dbManager, chatHistoryManager, runner, deps } = consultScenario(launch);
        await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });
        startTurnTwo(chatHistoryManager, runner as never);

        const cards = chatHistoryManager.load("s1").filter((m) => m.subAgentConsult);
        expect(cards).toHaveLength(1);
        expect(cards[0].subAgentConsult?.status).toBe("success");
        expect(cards[0].subAgentConsult?.outputMarkdown).toBe(OUTPUT);
        dbManager.close();
      });

      it("does not duplicate the finished turn it landed after", async () => {
        const { dbManager, chatHistoryManager, deps } = consultScenario(launch);
        await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

        const echoes = chatHistoryManager.load("s1").filter((m) => m.text === TURN_ONE_TEXT);
        expect(echoes).toHaveLength(1);
        dbManager.close();
      });
    });
  }
});

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
        fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex findings");
        if (opts.turnEndsDuringConsult) runner.running = false;
        return { status: "success" as const, text: "done", truncated: false, durationMs: 1_100_000, costUsd: 0 };
      }),
    };
    const deps = {
      sessionManager: { get: () => ({ id: "s1", kind: "repo", agentId: "claude", agentPinned: true }), list: () => [] },
      credentialStore: { getEnableSubAgents: () => true },
      agentRegistry: { refreshAuth: vi.fn(), get: () => ({ name: "Codex", installed: true, hasRunnableModels: true }) },
      runnerRegistry: { get: () => runner },
      usageManager: { record: vi.fn(), getSessionUsage: () => null, getSessionTokenTotals: () => null },
      chatHistoryManager: { replaceInProgress: vi.fn(), append: vi.fn(), updateSubAgentConsultCard: vi.fn(() => true) },
      createGitManager: (dir: string) => new GitManager(dir),
    } as never;
    return { runner, deps, schedulePostTurnPush };
  }

  it("commits and pushes the consult's work once its turn is over", async () => {
    const { deps, schedulePostTurnPush } = scenario({ turnEndsDuringConsult: true });

    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    const log = await git.log();
    expect(log[0].message).toContain("Sub-agent consult (codex)");
    expect(schedulePostTurnPush).toHaveBeenCalledTimes(1);
    expect(await git.isClean()).toBe(true);
  });

  it("leaves the work to the ordinary post-turn commit while the turn is still running", async () => {
    const { deps, schedulePostTurnPush } = scenario({ turnEndsDuringConsult: false });

    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect((await git.log()).length).toBe(2);
    expect(schedulePostTurnPush).not.toHaveBeenCalled();
    expect(await git.isClean()).toBe(false);
  });

  it("still delivers the consult's result when the commit path fails", async () => {
    const { deps } = scenario({ turnEndsDuringConsult: true });
    (deps as unknown as { createGitManager: (d: string) => GitManager }).createGitManager = () =>
      new GitManager(fs.mkdtempSync(path.join(os.tmpdir(), "shipit-not-a-repo-")));

    const res = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(res.status).toBe("success");
    expect(res.text).toBe("done");
  });
});

describe("runSubAgent — handing a finished consult back to the agent (docs/287)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let git: GitManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-sub-agent-deliver-"));
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

  function scenario(opts: { spawnResult?: Partial<SubAgentRunResult>; holdDelivery?: boolean } = {}) {
    const runner = {
      subAgentSpawnsThisTurn: 0,
      sessionId: "s1",
      sessionDir: tmpDir,
      running: true,
      turnEpoch: 4,
      turnSummary: "Launching a Codex review in the background",
      pendingCommitLink: null as unknown,
      emitMessage: vi.fn(),
      schedulePostTurnPush: vi.fn(),
      chatMessageGroups: [] as never[],
      steeredMessages: [] as never[],
      recordedCards: [] as never[],
      spawnSubAgent: vi.fn(async () => {
        fs.writeFileSync(path.join(tmpDir, "consult.md"), "codex findings");
        runner.running = false;
        return {
          status: "success" as const,
          text: "done",
          truncated: false,
          durationMs: 1_100_000,
          costUsd: 0,
          ...opts.spawnResult,
        };
      }),
    };
    let treeCleanAtDelivery: boolean | undefined;
    let settleGate: (() => void) | undefined;
    const gate = opts.holdDelivery
      ? new Promise<void>((r) => { settleGate = r; })
      : Promise.resolve();
    const deliverConsultResult = vi.fn(async (_req: ConsultResultDeliveryRequest) => {
      treeCleanAtDelivery = await git.isClean();
      await gate;
    });
    const deps = {
      sessionManager: { get: () => ({ id: "s1", kind: "repo", agentId: "claude", agentPinned: true }), list: () => [] },
      credentialStore: { getEnableSubAgents: () => true },
      agentRegistry: { refreshAuth: vi.fn(), get: () => ({ name: "Codex", installed: true, hasRunnableModels: true }) },
      runnerRegistry: { get: () => runner },
      usageManager: { record: vi.fn(), getSessionUsage: () => null, getSessionTokenTotals: () => null },
      chatHistoryManager: { replaceInProgress: vi.fn(), append: vi.fn(), updateSubAgentConsultCard: vi.fn(() => true) },
      createGitManager: (dir: string) => new GitManager(dir),
      deliverConsultResult,
    } as never;
    return {
      runner,
      deps,
      deliverConsultResult,
      treeClean: () => treeCleanAtDelivery,
      releaseDelivery: () => settleGate?.(),
      delivery: () => deliverConsultResult.mock.results[0]?.value as Promise<void> | undefined,
    };
  }

  it("delivers the terminal card, with the turn that asked for it, after the commit", async () => {
    const s = scenario();

    const res = await runSubAgent(deps(s), "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(s.deliverConsultResult).toHaveBeenCalledTimes(1);
    const req = s.deliverConsultResult.mock.calls[0][0];
    expect(req.sessionId).toBe("s1");
    expect(req.originatingTurnEpoch).toBe(4);
    expect(req.card.status).toBe("success");
    expect(req.card.spawnId).toBe(res.spawnId);
    expect(req.card.outputMarkdown).toBe("done");
    await s.delivery();
    expect(s.treeClean()).toBe(true);
  });

  it("returns the result without waiting for the delivery to finish", async () => {
    const s = scenario({ holdDelivery: true });

    const res = await runSubAgent(deps(s), "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(res.text).toBe("done");
    expect(s.deliverConsultResult).toHaveBeenCalledTimes(1);
    s.releaseDelivery();
    await s.delivery();
  });

  it("delivers a failed consult too", async () => {
    const s = scenario({ spawnResult: { status: "error", text: "", error: "boom" } });

    await runSubAgent(deps(s), "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(s.deliverConsultResult).toHaveBeenCalledTimes(1);
    expect(s.deliverConsultResult.mock.calls[0][0].card.status).toBe("error");
  });

  it("still returns the consult's result when the delivery throws", async () => {
    const s = scenario();
    s.deliverConsultResult.mockImplementation(async () => { throw new Error("registry exploded"); });

    const res = await runSubAgent(deps(s), "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(res.status).toBe("success");
    expect(res.text).toBe("done");
  });

  function deps(s: { deps: unknown }): Parameters<typeof runSubAgent>[0] {
    return s.deps as Parameters<typeof runSubAgent>[0];
  }
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
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "auth.json"), "{}");

    provisionSubAgentCredentials(root, "sessA", "codex");
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

    expect(fs.existsSync(path.join(dirA, "auth.json"))).toBe(false);
    expect(fs.existsSync(dirB)).toBe(true);
  });

  it("is a no-op without a credentialsDir (local mode)", () => {
    const sessionManager = { list: () => [{ id: "sessA", agentId: "claude" }] } as never;
    expect(() => sweepSubAgentCredentialsOnSignOut("codex", { sessionManager })).not.toThrow();
  });
});

describe("runSubAgent — same-harness spawns never touch the session's live credentials", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-spawn-home-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    clearSubtreeBorrows();
  });

  const claudeCreds = (tail: string) =>
    JSON.stringify({ claudeAiOauth: { accessToken: `tok-${tail}`, refreshToken: "r", expiresAt: 10_000 } });
  const seedClaude = (dir: string, tail: string) => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), claudeCreds(tail));
  };

  function captureSpawn(runner: { spawnSubAgent: unknown }, sessionFile: string) {
    const seen: { homeDir?: string; sessionBytes?: string; marker?: string; homeToken?: string } = {};
    runner.spawnSubAgent = vi.fn(async (req: { spawnId: string; homeDir?: string }) => {
      seen.homeDir = req.homeDir;
      seen.sessionBytes = fs.readFileSync(sessionFile, "utf-8");
      seen.marker = readSessionAccountMarker(root, "s1").claude;
      const homeFile = path.join(subAgentSpawnHomeDir(root, "s1", req.spawnId), ".claude", ".credentials.json");
      if (fs.existsSync(homeFile)) seen.homeToken = fs.readFileSync(homeFile, "utf-8");
      return { status: "success", text: "ok", truncated: false, durationMs: 5, costUsd: 0 };
    }) as never;
    return seen;
  }

  it("an account-routed same-harness spawn runs from an isolated home; the primary's file stays byte-identical", async () => {
    seedClaude(path.join(root, "provider-accounts", "claude", "acct-primary"), "CONSULT");
    const sessionDir = perSessionCredentialsDir(root, "s1");
    seedClaude(sessionDir, "PRIMARY-LIVE");
    writeSessionAccountMarker(root, "s1", "claude", "acct-session");
    const sessionFile = path.join(sessionDir, ".claude", ".credentials.json");
    const before = fs.readFileSync(sessionFile, "utf-8");

    const { deps, runner } = makeDeps({ credentialsDir: root, containerRunner: true });
    const seen = captureSpawn(runner, sessionFile);

    const result = await runSubAgent(deps, "s1", { target: explicit("claude"), prompt: "review", depth: 0 });

    expect(seen.homeDir).toBe(`/credentials/sub-agent-homes/${result.spawnId}`);
    expect(seen.homeToken).toContain("tok-CONSULT");
    expect(seen.sessionBytes).toBe(before);
    expect(seen.marker).toBe("acct-session");
    expect(fs.readFileSync(sessionFile, "utf-8")).toBe(before);
    expect(readSessionAccountMarker(root, "s1").claude).toBe("acct-session");
    expect(fs.existsSync(subAgentSpawnHomeDir(root, "s1", result.spawnId))).toBe(false);
  });

  it("a string-routed (flat) same-harness spawn is isolated too — the GLM shape", async () => {
    seedClaude(root, "FLAT");
    const sessionDir = perSessionCredentialsDir(root, "s1");
    seedClaude(sessionDir, "PRIMARY-LIVE");
    writeSessionAccountMarker(root, "s1", "claude", "acct-session");
    const sessionFile = path.join(sessionDir, ".claude", ".credentials.json");
    const before = fs.readFileSync(sessionFile, "utf-8");

    const { deps, runner } = makeDeps({
      credentialsDir: root,
      containerRunner: true,
      credentialRoutes: [{
        id: "anthropic-key", serviceId: "anthropic", billingMode: "key", via: "string",
        status: "ready", priority: 0, isPrimary: true, label: "test", createdAt: 0, updatedAt: 0,
      }],
    });
    const seen = captureSpawn(runner, sessionFile);

    const result = await runSubAgent(deps, "s1", {
      target: explicit("claude", { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" }),
      prompt: "review",
      depth: 0,
    });

    expect(seen.homeDir).toBe(`/credentials/sub-agent-homes/${result.spawnId}`);
    expect(seen.homeToken).toContain("tok-FLAT");
    expect(seen.sessionBytes).toBe(before);
    expect(fs.readFileSync(sessionFile, "utf-8")).toBe(before);
    expect(readSessionAccountMarker(root, "s1").claude).toBe("acct-session");
    expect(fs.existsSync(subAgentSpawnHomeDir(root, "s1", result.spawnId))).toBe(false);
  });

  it("a cross-harness spawn still borrows the session subtree and gets no homeDir", async () => {
    fs.mkdirSync(path.join(root, "provider-accounts", "codex", "acct-primary", ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "provider-accounts", "codex", "acct-primary", ".codex", "auth.json"),
      '{"tokens":{"access_token":"codex-consult"}}',
    );
    const sessionDir = perSessionCredentialsDir(root, "s1");
    seedClaude(sessionDir, "PRIMARY-LIVE");

    const { deps, runner } = makeDeps({ credentialsDir: root, containerRunner: true });
    const seen: { homeDir?: string; codexOnDisk?: boolean; marker?: string } = {};
    runner.spawnSubAgent = vi.fn(async (req: { homeDir?: string }) => {
      seen.homeDir = req.homeDir;
      seen.codexOnDisk = fs.existsSync(path.join(sessionDir, ".codex", "auth.json"));
      seen.marker = readSessionAccountMarker(root, "s1").codex;
      return { status: "success", text: "ok", truncated: false, durationMs: 5, costUsd: 0 };
    }) as never;

    await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(seen.homeDir).toBeUndefined();
    expect(seen.codexOnDisk).toBe(true);
    expect(seen.marker).toBe("acct-primary");
    expect(fs.existsSync(path.join(sessionDir, ".codex", "auth.json"))).toBe(false);
    expect(readSessionAccountMarker(root, "s1").codex).toBeUndefined();
  });

  it("closes the credential borrow when the run ends on its wall-clock cap", async () => {
    fs.mkdirSync(path.join(root, "provider-accounts", "codex", "acct-primary", ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "provider-accounts", "codex", "acct-primary", ".codex", "auth.json"),
      '{"tokens":{"access_token":"codex-consult"}}',
    );
    const sessionDir = perSessionCredentialsDir(root, "s1");
    seedClaude(sessionDir, "PRIMARY-LIVE");

    const { deps, runner, updateSubAgentConsultCard } = makeDeps({ credentialsDir: root, containerRunner: true });
    let borrowedDuringRun = false;
    runner.spawnSubAgent = vi.fn(async () => {
      borrowedDuringRun = fs.existsSync(path.join(sessionDir, ".codex", "auth.json"));
      runner.running = false;
      return { status: "timeout", text: "half a review", truncated: true, durationMs: 1_800_000, costUsd: 0 };
    }) as never;

    const res = await runSubAgent(deps, "s1", { target: explicit("codex"), prompt: "review", depth: 0 });

    expect(res.status).toBe("timeout");
    expect(borrowedDuringRun).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, ".codex", "auth.json"))).toBe(false);
    expect(readSessionAccountMarker(root, "s1").codex).toBeUndefined();
    expect(updateSubAgentConsultCard).toHaveBeenCalledWith(
      "s1",
      expect.any(String),
      expect.objectContaining({ status: "timeout", truncated: true }),
    );
  });
});
