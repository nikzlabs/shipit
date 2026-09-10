import { randomUUID } from "node:crypto";
import type { AgentId, NonTurnFailureCard } from "../../shared/types.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { UsageManager } from "../usage.js";
import type { CredentialStore } from "../credential-store.js";
import type { SessionManager } from "../sessions.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { PersistedMessage } from "../chat-history.js";
import {
  emitChatCard,
  persistCardTransition,
  type InProgressPersister,
} from "../chat-card-persistence.js";
import { resolveTurnCost, turnAttributionFor } from "../turn-attribution.js";
import { getErrorMessage } from "../validation.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import {
  provisionProviderAccountCredentials,
  provisionSubAgentCredentials,
  provisionSubAgentSpawnHome,
  releaseSubAgentCredentials,
  releaseSubAgentSpawnHome,
  subAgentSpawnHomeContainerDir,
  subAgentSpawnHomeDir,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
} from "../session-credentials.js";
import {
  resolveNonTurnModel,
  type GenerateText,
  type NonTurnPurpose,
  type NonTurnResolution,
  type NonTurnTarget,
} from "../non-turn-model.js";

export const NON_TURN_SPAWN_TIMEOUT_MS = 3 * 60_000;

export const NON_TURN_MAX_OUTPUT_CHARS = 8_000;

export interface NonTurnFailurePersister extends InProgressPersister {
  updateNonTurnFailureCard(
    sessionId: string,
    cardId: string,
    patch: Partial<NonTurnFailureCard>,
  ): boolean;
}

export interface NonTurnWorkDeps {
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  credentialStore: CredentialStore;
  providerAccountManager?: ProviderAccountManager | undefined;
  // The generator is constructed before the registry that uses it.
  getRunnerRegistry: () => SessionRunnerRegistry | undefined;
  chatHistoryManager: NonTurnFailurePersister;
  usageManager?: UsageManager | undefined;
  credentialsDir?: string | undefined;
  sessionManager?: Pick<SessionManager, "get"> | undefined;
}

export interface NonTurnTelemetry {
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

// Unattributed runs record token volume without a price; absent telemetry creates no row.
export function recordNonTurnUsage(
  deps: Pick<NonTurnWorkDeps, "usageManager">,
  args: {
    sessionId: string;
    harnessId: AgentId;
    target?: NonTurnTarget | undefined;
    purpose: NonTurnPurpose;
    telemetry: NonTurnTelemetry;
  },
): void {
  const { usageManager } = deps;
  if (!usageManager) return;
  const { telemetry, target, harnessId } = args;
  const hasTokens =
    telemetry.inputTokens !== undefined
    || telemetry.outputTokens !== undefined
    || telemetry.cacheReadTokens !== undefined
    || telemetry.cacheCreateTokens !== undefined;
  if (!hasTokens && (!target || telemetry.costUsd === undefined)) {
    const where = target
      ? `on ${target.selection.serviceId}/${target.selection.billingMode}`
      : "with no model resolved";
    console.warn(
      `[non-turn] no token telemetry from ${harnessId} for ${args.purpose}`
      + ` ${where}; nothing recorded`,
    );
    return;
  }
  const attribution = target ? turnAttributionFor(target.selection) : undefined;
  const cost = target
    ? resolveTurnCost({
        harnessId,
        attribution,
        reportedCostUsd: telemetry.costUsd,
        // One-shot usage is not a cumulative conversation total.
        reportedCostSource: "per-turn",
        tokens: {
          input: telemetry.inputTokens,
          output: telemetry.outputTokens,
          cacheRead: telemetry.cacheReadTokens,
          cacheWrite: telemetry.cacheCreateTokens,
        },
      })
    : { costUsd: 0, costSource: "per-turn" as const };
  usageManager.record(
    args.sessionId,
    cost.costUsd,
    telemetry.durationMs,
    telemetry.inputTokens,
    telemetry.outputTokens,
    {
      // Keep this run outside the primary agent's delta chain and context dial.
      subAgentId: harnessId,
      costSource: cost.costSource,
      ...(target ? { model: target.selection.modelId } : {}),
      ...(attribution ? { attribution } : {}),
      ...(telemetry.cacheReadTokens !== undefined ? { cacheRead: telemetry.cacheReadTokens } : {}),
      ...(telemetry.cacheCreateTokens !== undefined ? { cacheCreate: telemetry.cacheCreateTokens } : {}),
    },
  );
}

const FALLBACK_TEXT: Record<NonTurnPurpose, string> = {
  "session-naming": "The session kept its placeholder title.",
  "pr-description": "The pull request got a generic description.",
};

export function emitNonTurnFailure(
  deps: Pick<NonTurnWorkDeps, "getRunnerRegistry" | "chatHistoryManager">,
  args: {
    sessionId: string;
    purpose: NonTurnPurpose;
    target?: NonTurnTarget | undefined;
    unavailable?: { serviceName: string; serviceId: string; billingMode: "sub" | "key"; modelId: string } | undefined;
    detail?: string | undefined;
  },
): NonTurnFailureCard {
  const { sessionId, purpose } = args;
  const named = args.target
    ? {
        serviceId: args.target.selection.serviceId,
        serviceName: args.target.serviceName,
        billingMode: args.target.selection.billingMode,
        modelId: args.target.selection.modelId,
        pinned: args.target.source === "pinned",
      }
    : args.unavailable
      ? {
          serviceId: args.unavailable.serviceId,
          serviceName: args.unavailable.serviceName,
          billingMode: args.unavailable.billingMode,
          modelId: args.unavailable.modelId,
          pinned: true,
        }
      : undefined;

  const card: NonTurnFailureCard = {
    cardId: randomUUID(),
    purpose,
    ...(named ?? {}),
    fallback: FALLBACK_TEXT[purpose],
    ...(args.detail ? { detail: args.detail.slice(0, 300) } : {}),
    createdAt: new Date().toISOString(),
  };
  const persisted: PersistedMessage = { role: "assistant", text: "", nonTurnFailure: card };
  const runner = deps.getRunnerRegistry()?.get(sessionId);
  if (runner) {
    emitChatCard(
      runner,
      { type: "non_turn_failure_card", sessionId, card },
      persisted,
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
    );
  } else {
    // Background work can finish after its runner is gone; the notice must survive.
    deps.chatHistoryManager.append(sessionId, persisted);
  }
  console.warn(
    `[non-turn] ${purpose} failed session=${sessionId} `
    + `service=${named?.serviceId ?? "-"}/${named?.billingMode ?? "-"} `
    + `model=${named?.modelId ?? "-"}: ${args.detail ?? "no detail"}`,
  );
  return card;
}

// Patch recorded cards as well as the DB, or turn finalization can undo dismissal.
export function dismissNonTurnFailure(
  deps: Pick<NonTurnWorkDeps, "getRunnerRegistry" | "chatHistoryManager">,
  sessionId: string,
  cardId: string,
): boolean {
  const dismissedAt = new Date().toISOString();
  const runner = deps.getRunnerRegistry()?.get(sessionId);
  let patched = true;
  if (runner) {
    persistCardTransition(
      runner,
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
      (m) => m.nonTurnFailure?.cardId === cardId,
      (m) => (m.nonTurnFailure
        ? { ...m, nonTurnFailure: { ...m.nonTurnFailure, dismissedAt } }
        : m),
      () => {
        patched = deps.chatHistoryManager.updateNonTurnFailureCard(sessionId, cardId, { dismissedAt });
      },
    );
  } else {
    patched = deps.chatHistoryManager.updateNonTurnFailureCard(sessionId, cardId, { dismissedAt });
  }
  if (!patched) return false;
  runner?.emitMessage({ type: "non_turn_failure_dismissed", sessionId, cardId, dismissedAt });
  return true;
}

// Failed resolved runs return blank for the caller's prose fallback, without changing models.
export function makeNonTurnGenerateText(
  deps: NonTurnWorkDeps & { fallback: GenerateText },
): GenerateText {
  return async (prompt, cwd, opts) => {
    const sessionId = opts?.sessionId;
    const purpose = opts?.purpose ?? "pr-description";
    if (!sessionId) return deps.fallback(prompt, cwd, opts);

    const resolution = resolveNonTurnModel({
      credentialStore: deps.credentialStore,
      providerAccountManager: deps.providerAccountManager,
    });
    // Local CLI auth can exist outside the configured registry. Let the fallback try it.
    // Forward opts so the fallback can record any usage it produces.
    if (!resolution.ok && resolution.reason === "nothing_eligible") {
      console.warn(
        `[non-turn] ${purpose} session=${sessionId}: no eligible model on any installed harness;`
        + " falling back to the pre-feature generator",
      );
      return deps.fallback(prompt, cwd, opts);
    }
    if (!resolution.ok) {
      reportUnrunnable(deps, sessionId, purpose, resolution);
      return "";
    }

    const target = resolution.target;
    const runner = deps.getRunnerRegistry()?.get(sessionId);
    if (!runner) {
      emitNonTurnFailure(deps, {
        sessionId,
        purpose,
        target,
        detail: "The session's container was not running.",
      });
      return "";
    }

    return runNonTurnSpawn(deps, { sessionId, purpose, target, prompt, runner });
  };
}

function reportUnrunnable(
  deps: Pick<NonTurnWorkDeps, "getRunnerRegistry" | "chatHistoryManager">,
  sessionId: string,
  purpose: NonTurnPurpose,
  resolution: Extract<NonTurnResolution, { ok: false; reason: "pin_unavailable" }>,
): void {
  emitNonTurnFailure(deps, {
    sessionId,
    purpose,
    unavailable: {
      serviceName: resolution.serviceName,
      serviceId: resolution.selection.serviceId,
      billingMode: resolution.selection.billingMode,
      modelId: resolution.selection.modelId,
    },
    detail: "The chosen model is no longer available — its credential or harness is gone.",
  });
}

async function runNonTurnSpawn(
  deps: NonTurnWorkDeps,
  args: {
    sessionId: string;
    purpose: NonTurnPurpose;
    target: NonTurnTarget;
    prompt: string;
    runner: SessionRunnerInterface;
  },
): Promise<string> {
  const { sessionId, purpose, target, runner } = args;
  const spawnId = randomUUID();
  const credentialsDir = deps.credentialsDir;
  const provisioned = (runner instanceof ContainerSessionRunner || target.harnessId === "opencode") && !!credentialsDir;
  const accountId = target.route?.kind === "account" ? target.route.id : undefined;
  // Isolate same-harness credentials from the live primary CLI, which can reread them mid-turn.
  const sameHarness = deps.sessionManager?.get(sessionId)?.agentId === target.harnessId || target.harnessId === "opencode";
  try {
    // Provision inside try so partial failures still release the credential borrow.
    if (target.harnessId === "opencode" && accountId && deps.ensureAgentTokenFresh && !await deps.ensureAgentTokenFresh("codex", accountId)) throw new Error("ChatGPT account renewal failed.");
    if (provisioned && credentialsDir) {
      if (sameHarness) {
        provisionSubAgentSpawnHome(credentialsDir, sessionId, spawnId, target.harnessId, accountId);
      } else {
        provisionSubAgentCredentials(credentialsDir, sessionId, target.harnessId, accountId);
      }
    }
    const result = await runner.spawnSubAgent({
      agentId: target.harnessId,
      prompt: args.prompt,
      spawnId,
      depth: 0,
      model: target.selection.modelId,
      ...(target.serviceRouting ? { serviceRouting: target.serviceRouting } : {}),
      ...(sameHarness && provisioned
        ? { homeDir: runner instanceof ContainerSessionRunner ? subAgentSpawnHomeContainerDir(spawnId) : subAgentSpawnHomeDir(credentialsDir, sessionId, spawnId) }
        : {}),
      timeoutMs: NON_TURN_SPAWN_TIMEOUT_MS,
      maxOutputChars: NON_TURN_MAX_OUTPUT_CHARS,
    });
    recordNonTurnUsage(deps, {
      sessionId,
      harnessId: target.harnessId,
      target,
      purpose,
      telemetry: {
        durationMs: result.durationMs,
        // The initial zero is not evidence that a cost was reported.
        ...(result.costReported ? { costUsd: result.costUsd } : {}),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.cacheReadTokens !== undefined ? { cacheReadTokens: result.cacheReadTokens } : {}),
        ...(result.cacheCreateTokens !== undefined ? { cacheCreateTokens: result.cacheCreateTokens } : {}),
      },
    });
    if (result.status !== "success" || !result.text.trim()) {
      emitNonTurnFailure(deps, {
        sessionId,
        purpose,
        target,
        detail: result.error ?? `The run ended ${result.status} with no text.`,
      });
      return "";
    }
    return result.text;
  } catch (err) {
    emitNonTurnFailure(deps, { sessionId, purpose, target, detail: getErrorMessage(err) });
    return "";
  } finally {
    // Sync renewed tokens before removing borrowed credentials.
    if (provisioned && credentialsDir) {
      if (sameHarness) {
        releaseSubAgentSpawnHome(credentialsDir, sessionId, spawnId);
      } else {
        try {
          if (accountId) syncProviderAccountTokenBack(credentialsDir, sessionId, target.harnessId, accountId);
          else syncAgentTokenBack(credentialsDir, sessionId, target.harnessId);
        } catch {
          // Release the borrow even when token sync fails.
        }
        // The borrow captured the prior account; reading the current marker would find the borrower.
        const restoreAccountId = releaseSubAgentCredentials(credentialsDir, sessionId, target.harnessId);
        const session = deps.sessionManager?.get(sessionId);
        if (session?.agentId === target.harnessId && restoreAccountId) {
          provisionProviderAccountCredentials(
            credentialsDir,
            sessionId,
            target.harnessId,
            restoreAccountId,
          );
        }
      }
    }
  }
}
