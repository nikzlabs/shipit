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
  unavailableFrom,
  type GenerateText,
  type NonTurnCardPurpose,
  type NonTurnDirectTarget,
  type NonTurnHarnessTarget,
  type NonTurnPinUnavailable,
  type NonTurnPurpose,
  type NonTurnTarget,
  type NonTurnUnavailable,
  type NonTurnUnavailableCause,
} from "../non-turn-model.js";
import { DirectCallError, directCallForStyle, type DirectCallUsage } from "../direct-provider/index.js";

export const NON_TURN_SPAWN_TIMEOUT_MS = 3 * 60_000;

/**
 * A direct call is one HTTP request with no CLI to boot and no container to
 * start, so it gets a far shorter budget than the harness spawn above. This is
 * not req 9's end-to-end deadline, which docs/299 phase 4 owns for voice
 * cleanup; it is the transport timeout for this one request.
 */
export const NON_TURN_DIRECT_TIMEOUT_MS = 60_000;

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
  // Injection point for the direct clients' transport.
  fetchImpl?: typeof fetch | undefined;
}

export interface NonTurnTelemetry {
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

/**
 * Unattributed runs record token volume without a price; absent telemetry creates
 * no row, unless `spendUnknown` says the run was billed an amount nobody can read.
 *
 * A null session id is install-level spend — background work belonging to no
 * session, which is reported install-wide rather than charged to whichever
 * session happened to be open (docs/299-direct-provider-calls req 7). An absent harness id means no
 * harness ran the work; the row is still background work, and says so in its own
 * field. Service and billing mode come from the *selection*, so a direct call on
 * a subscription stays subscription usage with an at-API-rates comparison.
 */
export function recordNonTurnUsage(
  deps: Pick<NonTurnWorkDeps, "usageManager">,
  args: {
    sessionId: string | null;
    harnessId?: AgentId | undefined;
    // The selection alone: what the user chose is what usage reports.
    target?: Pick<NonTurnTarget, "selection"> | undefined;
    purpose: NonTurnPurpose;
    telemetry: NonTurnTelemetry;
    /**
     * The run was billed but its amount cannot be read — a call cut off in
     * flight. The row is written with no counts, so the run is visible without
     * a figure being invented for it (docs/299-direct-provider-calls req 7).
     */
    spendUnknown?: boolean | undefined;
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
  if (!hasTokens && !args.spendUnknown && (!target || telemetry.costUsd === undefined)) {
    const where = target
      ? `on ${target.selection.serviceId}/${target.selection.billingMode}`
      : "with no model resolved";
    console.warn(
      `[non-turn] no token telemetry from ${harnessId ?? "a direct call"} for ${args.purpose}`
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
      // Keeps this run outside the primary agent's delta chain and context dial
      // whether or not a harness ran it.
      backgroundWork: true,
      ...(harnessId ? { subAgentId: harnessId } : {}),
      costSource: cost.costSource,
      ...(target ? { model: target.selection.modelId } : {}),
      ...(attribution ? { attribution } : {}),
      ...(telemetry.cacheReadTokens !== undefined ? { cacheRead: telemetry.cacheReadTokens } : {}),
      ...(telemetry.cacheCreateTokens !== undefined ? { cacheCreate: telemetry.cacheCreateTokens } : {}),
    },
  );
}

const FALLBACK_TEXT: Record<NonTurnCardPurpose, string> = {
  "session-naming": "The session kept its placeholder title.",
  "pr-description": "The pull request got a generic description.",
};

/**
 * The notice's sentence comes from the cause the resolver reported, never from
 * the caller. A fixed string stating a cause nothing checked sent users whose
 * credential was working to Settings to repair it — which is the damaging half,
 * since there is nothing there to fix (docs/299-direct-provider-calls req 3).
 */
const UNAVAILABLE_DETAIL: Record<NonTurnUnavailableCause, string> = {
  credential_gone:
    "ShipIt no longer has a credential for it. Add one under Model providers,"
    + " or choose another model for background work in Settings.",
  credential_unusable:
    "Its sign-in is no longer usable. Reconnect that account under Model providers,"
    + " or choose another model for background work in Settings.",
  no_background_carrier:
    "Its credential is still configured, but nothing on this install can run that model as"
    + " background work. Choose another model for background work in Settings.",
};

/**
 * Only a card purpose can reach this, so voice cleanup cannot persist a card by
 * accident (docs/299-direct-provider-calls req 6) — the executors below report
 * an outcome and leave the decision to emit to the caller that wants one.
 */
export function emitNonTurnFailure(
  deps: Pick<NonTurnWorkDeps, "getRunnerRegistry" | "chatHistoryManager">,
  args: {
    sessionId: string;
    purpose: NonTurnCardPurpose;
    target?: NonTurnTarget | undefined;
    unavailable?: NonTurnUnavailable | undefined;
    detail?: string | undefined;
  },
): NonTurnFailureCard {
  const { sessionId, purpose } = args;
  const detail = args.detail
    ?? (args.unavailable ? UNAVAILABLE_DETAIL[args.unavailable.cause] : undefined);
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
    ...(detail ? { detail: detail.slice(0, 300) } : {}),
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
    + `model=${named?.modelId ?? "-"}: ${detail ?? "no detail"}`,
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

/**
 * Failed resolved runs return blank for the caller's prose fallback, without
 * changing models.
 *
 * Resolution and execution sit ABOVE the session and runner gates below, because
 * a direct call needs neither (docs/299-direct-provider-calls req 4): it runs with no session open and
 * with the session's container reclaimed. A session id, where one exists, is
 * reporting context passed alongside — where to put a failure card, and which
 * session's usage to charge — not a precondition.
 */
export function makeNonTurnGenerateText(
  deps: NonTurnWorkDeps & { fallback: GenerateText },
): GenerateText {
  return async (prompt, cwd, opts) => {
    const sessionId = opts?.sessionId;
    const purpose = opts?.purpose ?? "pr-description";

    const resolution = resolveNonTurnModel({
      credentialStore: deps.credentialStore,
      providerAccountManager: deps.providerAccountManager,
    });

    const resolved = resolution.ok ? resolution.target : undefined;
    if (resolved?.execution === "direct") {
      const outcome = await runNonTurnDirect(deps, {
        sessionId: sessionId ?? null,
        purpose,
        target: resolved,
        prompt,
      });
      if (outcome.ok) return outcome.text;
      // Work belonging to no session has no transcript to carry the notice;
      // runNonTurnDirect has already logged the reason.
      if (sessionId) {
        emitNonTurnFailure(deps, { sessionId, purpose, target: resolved, detail: outcome.detail });
      }
      return "";
    }

    // Everything below runs a harness inside the session's own container.
    if (!sessionId) return deps.fallback(prompt, cwd, opts);

    // Local CLI auth can exist outside the configured registry. Let the fallback try it.
    // Forward opts so the fallback can record any usage it produces.
    if (!resolution.ok && resolution.reason === "nothing_eligible") {
      console.warn(
        `[non-turn] ${purpose} session=${sessionId}: no eligible model on any installed harness;`
        + " falling back to the pre-feature generator",
      );
      return deps.fallback(prompt, cwd, opts);
    }
    if (!resolved) {
      if (!resolution.ok) reportUnrunnable(deps, sessionId, purpose, resolution);
      return "";
    }

    const target = resolved;
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

/**
 * Failure is returned, never rendered: voice cleanup shares this path and must
 * write nothing to the chat transcript (docs/299-direct-provider-calls req 6).
 * The caller that wants a card emits one; the union makes forgetting visible to
 * the compiler.
 */
export type NonTurnOutcome =
  | { ok: true; text: string }
  | { ok: false; detail: string };

/**
 * Background work as a direct provider call, and the usage it spent (docs/299
 * reqs 2 and 7). The call and the recording are one entry point, because a
 * caller that had to remember the second half eventually would not.
 *
 * A null session id is install-level spend. No harness id is written, and the
 * service and billing mode come from the *selection*, so a direct call on a
 * subscription stays subscription usage with an at-API-rates comparison rather
 * than becoming metered spend.
 */
export async function runNonTurnDirect(
  deps: Pick<NonTurnWorkDeps, "usageManager" | "fetchImpl">,
  args: {
    sessionId: string | null;
    purpose: NonTurnPurpose;
    target: NonTurnDirectTarget;
    prompt: string;
    signal?: AbortSignal | undefined;
    maxOutputChars?: number | undefined;
  },
): Promise<NonTurnOutcome> {
  const { target, purpose, sessionId } = args;
  const startedAt = Date.now();
  const record = (usage: DirectCallUsage): void => {
    recordNonTurnUsage(deps, {
      sessionId,
      target,
      purpose,
      telemetry: {
        durationMs: Date.now() - startedAt,
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheCreateTokens !== undefined ? { cacheCreateTokens: usage.cacheCreateTokens } : {}),
      },
    });
  };
  const recordSpendUnknown = (): void => {
    recordNonTurnUsage(deps, {
      sessionId,
      target,
      purpose,
      spendUnknown: true,
      telemetry: { durationMs: Date.now() - startedAt },
    });
  };
  const fail = (detail: string): NonTurnOutcome => {
    console.warn(
      `[non-turn] ${purpose} direct call failed session=${sessionId ?? "-"} `
      + `service=${target.selection.serviceId}/${target.selection.billingMode}: ${detail}`,
    );
    return { ok: false, detail };
  };

  const call = directCallForStyle(target.call.style, deps.fetchImpl ?? fetch);
  if (!call) return fail(`No direct client speaks ${target.call.style}.`);

  try {
    const result = await call({
      baseUrl: target.call.baseUrl,
      apiModelId: target.call.apiModelId,
      apiKey: target.apiKey,
      ...(target.call.headers ? { headers: target.call.headers } : {}),
      prompt: args.prompt,
      maxOutputChars: args.maxOutputChars ?? NON_TURN_MAX_OUTPUT_CHARS,
      signal: args.signal ?? AbortSignal.timeout(NON_TURN_DIRECT_TIMEOUT_MS),
    });
    record(result);
    const text = result.text.trim();
    // A provider can answer 200 with no content; every caller wants text.
    return text ? { ok: true, text } : fail("The call returned no text.");
  } catch (err) {
    // A run that stopped on its output cap, or wrote only reasoning, fails and
    // is billed. Record what it spent before reporting it (docs/299-direct-provider-calls req 7).
    if (err instanceof DirectCallError && err.usage) record(err.usage);
    // A call cut off before its body could be read may have been billed, and
    // its counts were only ever going to arrive in that body. Record the run
    // without them, rather than let cleanup's own deadline erase real spend
    // from every total.
    else if (err instanceof DirectCallError && err.spendUnknown) recordSpendUnknown();
    return fail(getErrorMessage(err));
  }
}

function reportUnrunnable(
  deps: Pick<NonTurnWorkDeps, "getRunnerRegistry" | "chatHistoryManager">,
  sessionId: string,
  purpose: NonTurnCardPurpose,
  resolution: NonTurnPinUnavailable,
): void {
  emitNonTurnFailure(deps, { sessionId, purpose, unavailable: unavailableFrom(resolution) });
}

async function runNonTurnSpawn(
  deps: NonTurnWorkDeps,
  args: {
    sessionId: string;
    // A session's own container runs only the card purposes; voice cleanup has
    // its own runner and never reaches here.
    purpose: NonTurnCardPurpose;
    target: NonTurnHarnessTarget;
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
        provisionSubAgentCredentials(credentialsDir, sessionId, target.harnessId, spawnId, accountId);
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
        const restoreAccountId = releaseSubAgentCredentials(credentialsDir, sessionId, target.harnessId, spawnId);
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
