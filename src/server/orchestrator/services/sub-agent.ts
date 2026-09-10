import { randomUUID } from "node:crypto";
import { resolveTurnCost, turnAttributionFor } from "../turn-attribution.js";
import { selectRouteForSelection, serviceRoutingForSelection } from "../service-routing.js";
import type {
  AgentId,
  SubAgentConsultCard,
  SubAgentSpawnTarget,
  WsServerMessage,
} from "../../shared/types.js";
import {
  assertHarnessCanRunSelection,
  implementerFor,
  resolveSubAgentSpawnTarget,
  type ResolvedSpawnTarget,
} from "./sub-agent-target.js";
import { joinRolePrompt, ROLE_PROMPT_LIMITS } from "./roles.js";
import type { SessionManager } from "../sessions.js";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import { isHarnessInstalled } from "../../shared/installed-harnesses.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import { accountServiceForHarness } from "../provider-account-manager.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { UsageManager } from "../usage.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import {
  emitChatCard,
  persistCardTransition,
  type InProgressPersister,
} from "../chat-card-persistence.js";
import { WorkerAbortedError, WorkerTimeoutError } from "../worker-http.js";
import { projectConsultCardForWire } from "../transcript-projection.js";
import {
  provisionSubAgentCredentials,
  provisionSubAgentSpawnHome,
  provisionProviderAccountCredentials,
  preserveBorrowedTokensBeforeWipe,
  releaseSubAgentCredentials,
  releaseSubAgentSpawnHome,
  removeSubAgentCredentials,
  subAgentSpawnHomeContainerDir,
  subAgentSpawnHomeDir,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
} from "../session-credentials.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import {
  detectHardExhaustion,
  detectHardExhaustionInTurnText,
  exhaustionLockoutUntil,
} from "../ws-handlers/agent-rate-limits.js";
import { commitSubAgentWork } from "./sub-agent-commit.js";
import type { ConsultResultDeliveryRequest } from "./consult-result-delivery.js";
import type { GitManager } from "../../shared/git.js";
import { ServiceError } from "./types.js";

export const SUB_AGENT_PER_TURN_CAP = 3;

export interface ConsultCardPersister extends InProgressPersister {
  updateSubAgentConsultCard(
    sessionId: string,
    cardId: string,
    patch: Partial<SubAgentConsultCard>,
  ): boolean;
  listSubAgentConsultCards?(sessionId: string): SubAgentConsultCard[];
}

function rejectSpawn(
  sessionId: string,
  subAgentId: string,
  statusCode: number,
  reason: string,
  message: string,
): ServiceError {
  console.warn(
    `[sub-agent] rejected session=${sessionId} agent=${subAgentId} reason=${reason} status=${statusCode}`,
  );
  return new ServiceError(statusCode, message);
}

export interface RunSubAgentDeps {
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  sessionManager: SessionManager;
  credentialStore: CredentialStore;
  agentRegistry: AgentRegistry;
  providerAccountManager?: ProviderAccountManager;
  runnerRegistry: SessionRunnerRegistry;
  usageManager: UsageManager;
  chatHistoryManager: ConsultCardPersister;
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
    sessionId?: string,
    // Consults route independently of their session's account pin.
    routeId?: string,
  ) => void;
  credentialsDir?: string;
  createGitManager?: (dir: string) => GitManager;
  deliverConsultResult?: (req: ConsultResultDeliveryRequest) => Promise<unknown>;
}

export interface RunSubAgentInput {
  target: SubAgentSpawnTarget;
  prompt: string;
  depth: number;
}

export interface RunSubAgentResult extends SubAgentRunResult {
  subAgentId: AgentId;
  spawnId: string;
}

function allAccountsExhaustedMessage(providerName: string, earliestResetAt: string | null): string {
  const reset = earliestResetAt
    ? ` Earliest reset: ${new Date(earliestResetAt).toISOString()}.`
    : "";
  return `Every connected ${providerName} subscription account is out of quota.${reset}`;
}

export function teardownConsultDetail(reason?: string): string {
  const named = reason ? ` (${reason})` : "";
  return `The session container was torn down while this consult was running${named}`
    + ", so its result was lost. Re-run the consult if you still need it.";
}

export const HOST_SHUTDOWN_CONSULT_DETAIL =
  "The process running this consult was shut down with its session before the "
  + "consult finished, so its result was lost. Re-run the consult if you still "
  + "need it.";

export const UNATTRIBUTED_CONSULT_DETAIL =
  "This consult was cancelled before it finished, and ShipIt could not "
  + "determine what ended it. Re-run the consult if you still need it.";

export async function runSubAgent(
  deps: RunSubAgentDeps,
  sessionId: string,
  input: RunSubAgentInput,
): Promise<RunSubAgentResult> {
  const { target, depth } = input;
  const requested = target.kind === "role" ? `role:${target.role}` : target.harnessId;
  let prompt = input.prompt;
  let promptBytes = typeof prompt === "string" ? Buffer.byteLength(prompt) : 0;
  console.log(
    `[sub-agent] requested session=${sessionId} target=${requested} depth=${depth} promptBytes=${promptBytes}`,
  );

  const session = deps.sessionManager.get(sessionId);
  if (!session) throw rejectSpawn(sessionId, requested, 404, "session_not_found", "Session not found");

  if (!deps.credentialStore.getEnableSubAgents()) {
    throw rejectSpawn(sessionId, requested, 403, "sub_agents_disabled",
      "Sub-agents are disabled. Enable them in Settings → Multi-agent sessions.");
  }

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw rejectSpawn(sessionId, requested, 400, "empty_prompt",
      "A prompt is required (pass it via --prompt-file -).");
  }

  if (!session.agentPinned || !session.agentId) {
    throw rejectSpawn(sessionId, requested, 409, "session_not_pinned",
      "This session has no pinned agent yet — send a message first.");
  }
  const implementerHarness = session.agentId;

  // A caller can forge depth; the runner's per-turn cap supplies the hard bound.
  if (depth !== 0) {
    throw rejectSpawn(sessionId, requested, 403, "recursion_depth",
      "Sub-agents cannot spawn further sub-agents.");
  }

  const runner = deps.runnerRegistry.get(sessionId);
  if (!runner) {
    throw rejectSpawn(sessionId, requested, 409, "session_inactive", "Session is not active.");
  }

  if (runner.subAgentSpawnsThisTurn >= SUB_AGENT_PER_TURN_CAP) {
    throw rejectSpawn(sessionId, requested, 429, "per_turn_cap",
      `Sub-agent spawn cap reached for this turn (max ${SUB_AGENT_PER_TURN_CAP}).`);
  }

  // Capture once so retries and attribution use the same target.
  const implementer = implementerFor(session, implementerHarness, runner.appliedSpawnIdentity);
  let resolvedTarget: ResolvedSpawnTarget;
  try {
    resolvedTarget = resolveSubAgentSpawnTarget(target, implementer, {
      credentialStore: deps.credentialStore,
      ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
    });
  } catch (err) {
    if (err instanceof ServiceError) {
      throw rejectSpawn(sessionId, requested, err.statusCode, "target_unresolvable", err.message);
    }
    throw err;
  }

  try {
    prompt = joinRolePrompt(prompt, resolvedTarget, ROLE_PROMPT_LIMITS.oneShot);
  } catch (err) {
    if (err instanceof ServiceError) {
      throw rejectSpawn(sessionId, requested, err.statusCode, "prompt_too_long", err.message);
    }
    throw err;
  }
  promptBytes = Buffer.byteLength(prompt);
  const subAgentId = resolvedTarget.harnessId;
  if (resolvedTarget.reviewer) {
    const r = resolvedTarget.reviewer;
    console.log(
      `[sub-agent] reviewer session=${sessionId} slot=${r.slot} source=${r.source} `
      + `tier=${r.tier} basis=${r.tierBasis} harness=${subAgentId} `
      + `model=${resolvedTarget.selection.serviceId}/${resolvedTarget.selection.billingMode}/`
      // "none" is an explicit Codex level, so absence is logged as "default".
      + `${resolvedTarget.selection.modelId} effort=${resolvedTarget.reasoningEffort ?? "default"}`,
    );
  }

  deps.agentRegistry.refreshAuth(subAgentId);
  const info = deps.agentRegistry.get(subAgentId);
  if (!info) throw rejectSpawn(sessionId, subAgentId, 400, "unknown_agent", `Unknown agent: ${subAgentId}`);
  if (!isHarnessInstalled(subAgentId)) {
    throw rejectSpawn(sessionId, subAgentId, 400, "not_installed",
      `${info.name} is not installed in this deployment.`);
  }
  if (!info.hasRunnableModels) {
    throw rejectSpawn(sessionId, subAgentId, 400, "not_signed_in",
      `${info.name} is not signed in. Connect it in Settings before spawning it.`);
  }

  const subSelection = resolvedTarget.selection;
  const reasoningEffort = resolvedTarget.reasoningEffort;
  const subAttribution = turnAttributionFor(subSelection);
  const spawnModel = subSelection.modelId;

  if (target.kind === "explicit") {
    try {
      assertHarnessCanRunSelection(info.name, info.eligibleModels, subSelection);
    } catch (err) {
      if (err instanceof ServiceError) {
        throw rejectSpawn(sessionId, subAgentId, err.statusCode, "harness_cannot_run", err.message);
      }
      throw err;
    }
  }

  runner.subAgentSpawnsThisTurn += 1;

  const selection = resolvedTarget.route
    ? undefined
    : deps.providerAccountManager
      ? selectRouteForSelection(subAgentId, subSelection, {
          credentialStore: deps.credentialStore,
          providerAccountManager: deps.providerAccountManager,
        })
      : undefined;
  if (selection && !selection.ok) {
    if (selection.reason === "all_exhausted") {
      throw rejectSpawn(sessionId, subAgentId, 429, "all_accounts_exhausted",
        allAccountsExhaustedMessage(info.name, selection.earliestResetAt));
    }
    throw rejectSpawn(sessionId, subAgentId, 400, "no_account_route",
      `${info.name} is not signed in. Connect it in Settings before spawning it.`);
  }
  let route = resolvedTarget.route ?? selection?.route ?? null;
  let accountId = route?.kind === "account" ? route.id : undefined;

  // Same-harness runs need private homes: the live primary re-reads its credential files.
  const isContainer = runner instanceof ContainerSessionRunner;
  // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
  const provisioned = (isContainer || subAgentId === "opencode") && !!deps.credentialsDir;
  const credentialsDir = deps.credentialsDir;
  // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
  const sameHarness = subAgentId === session.agentId || subAgentId === "opencode";

  const spawnId = randomUUID();
  const cardId = randomUUID();
  // Completion may happen during a different turn.
  const originatingTurnEpoch = runner.turnEpoch ?? 0;

  const provisionAttempt = async (): Promise<void> => {
    // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
    if (subAgentId === "opencode" && accountId && deps.ensureAgentTokenFresh && !await deps.ensureAgentTokenFresh("codex", accountId)) throw new ServiceError(401, "ChatGPT account renewal failed.");
    if (!provisioned || !credentialsDir) return;
    if (sameHarness) {
      console.log(
        `[sub-agent] provision-spawn-home session=${sessionId} spawn=${spawnId} agent=${subAgentId} `
        + `account=${accountId ?? "flat"}`,
      );
      provisionSubAgentSpawnHome(credentialsDir, sessionId, spawnId, subAgentId, accountId);
      return;
    }
    console.log(
      `[sub-agent] provision-credentials session=${sessionId} agent=${subAgentId} account=${accountId ?? "flat"}`,
    );
    provisionSubAgentCredentials(credentialsDir, sessionId, subAgentId, accountId);
  };
  const startedAtMs = Date.now();
  runner.emitMessage({ type: "sub_agent_spawn", sessionId, spawnId, subAgentId });

  console.log(
    `[sub-agent] accepted session=${sessionId} spawn=${spawnId} card=${cardId} agent=${subAgentId} `
    + `target=${requested} depth=${depth} promptBytes=${promptBytes} `
    + `route=${route?.kind ?? "default"}:${accountId ?? "-"} `
    + `model=${subSelection.serviceId}/${subSelection.billingMode}/${spawnModel} `
    + `effort=${reasoningEffort ?? "default"} spawnsThisTurn=${runner.subAgentSpawnsThisTurn}`,
  );

  // Persist at admission so background runs stay visible and anchored to their call site.
  const pendingCard: SubAgentConsultCard = {
    cardId,
    spawnId,
    subAgentId,
    ...(resolvedTarget.roleName ? { roleName: resolvedTarget.roleName } : {}),
    runOn: {
      serviceId: subSelection.serviceId,
      billingMode: subSelection.billingMode,
      modelId: subSelection.modelId,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    },
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  emitChatCard(
    runner,
    { type: "sub_agent_consult_card", sessionId, card: pendingCard },
    { role: "assistant", text: "", subAgentConsult: pendingCard },
    { chatHistoryManager: deps.chatHistoryManager, sessionId },
  );

  let terminalCard: SubAgentConsultCard | undefined;

  const finalizeConsultCard = (terminal: SubAgentConsultCard) => {
    const card: SubAgentConsultCard =
      terminal.status === "cancelled" && !terminal.statusDetail
        ? { ...terminal, statusDetail: UNATTRIBUTED_CONSULT_DETAIL }
        : terminal;
    terminalCard = card;
    if (card !== terminal) {
      console.warn(
        `[sub-agent] cancelled consult named no terminator session=${sessionId} `
        + `spawn=${spawnId} card=${cardId} — falling back to the unattributed detail`,
      );
    }
    const live = deps.runnerRegistry.get(sessionId) ?? runner;
    // Store the full output before emitting the preview; the browser fetches the stored copy.
    let patchedRow = true;
    const inFlight = persistCardTransition(
      live,
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
      (m) => m.subAgentConsult?.cardId === cardId,
      (m) => ({ ...m, subAgentConsult: card }),
      () => { patchedRow = deps.chatHistoryManager.updateSubAgentConsultCard(sessionId, cardId, card); },
    );
    live.emitMessage({
      type: "sub_agent_consult_card",
      sessionId,
      card: projectConsultCardForWire(card),
    });
    let durable = patchedRow;
    try {
      const rows = deps.chatHistoryManager.listSubAgentConsultCards?.(sessionId);
      if (rows) durable = rows.some((c) => c.cardId === cardId && c.status === card.status);
    } catch (err) {
      console.warn(`[sub-agent] durability read-back failed session=${sessionId} card=${cardId}:`, err);
    }
    console.log(
      `[sub-agent] finished session=${sessionId} spawn=${spawnId} card=${cardId} agent=${subAgentId} `
      + `status=${card.status} durationMs=${card.durationMs ?? 0} costUsd=${card.costUsd ?? 0} `
      + `outputChars=${card.outputMarkdown?.length ?? 0} truncated=${card.truncated === true} `
      + `emitted=true persisted=${durable} route=${inFlight ? "in-flight-turn" : "finalized-row"} `
      + `liveRunner=${live === runner ? "original" : "reresolved"}`,
    );
  };

  try {
    // Provision inside the try so partial borrows are closed on failure.
    await provisionAttempt();
    const spawn = () => {
      // Rebuild per attempt: failover can change the credential's environment variable.
      const subServiceRouting = serviceRoutingForSelection(
        subAgentId,
        subSelection,
        route,
        deps.credentialStore,
      );
      return runner.spawnSubAgent({
        agentId: subAgentId,
        prompt,
        spawnId,
        depth,
        ...(sameHarness && provisioned
          ? { homeDir: runner instanceof ContainerSessionRunner ? subAgentSpawnHomeContainerDir(spawnId) : subAgentSpawnHomeDir(credentialsDir!, sessionId, spawnId) }
          : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        model: spawnModel,
        ...(subServiceRouting !== undefined ? { serviceRouting: subServiceRouting } : {}),
      });
    };
    let result = await spawn();

    // A non-quota error must not let quota-looking partial output bench a healthy account.
    const detectExhaustion = (run: typeof result) =>
      (run.status === "error" && run.error
        ? detectHardExhaustion(run.error)
        : detectHardExhaustionInTurnText(run.text));

    const attemptedRouteIds = new Set(route ? [route.id] : []);
    let exhausted = detectExhaustion(result);
    while (exhausted && route && deps.providerAccountManager) {
      const failedRoute = route;
      const benchedUntil = exhaustionLockoutUntil(exhausted);
      if (failedRoute.kind === "account") {
        // The credential's service can differ from the harness vendor.
        const subAgentService =
          deps.credentialStore.getCredentialRoute(failedRoute.id)?.serviceId
          ?? accountServiceForHarness(subAgentId);
        deps.providerAccountManager.markAccountExhausted(
          subAgentService,
          failedRoute.id,
          benchedUntil,
        );
      } else if (!deps.credentialStore.markCredentialRouteExhausted(failedRoute.id, benchedUntil)) {
        break;
      }
      const fallback = selectRouteForSelection(subAgentId, subSelection, {
        credentialStore: deps.credentialStore,
        providerAccountManager: deps.providerAccountManager,
      }, { exclude: [...attemptedRouteIds] });
      if (!fallback.ok) {
        console.warn(
          `[sub-agent] account-fallback-exhausted session=${sessionId} spawn=${spawnId} `
          + `agent=${subAgentId} benched=${failedRoute.id} reason=${fallback.reason}`,
        );
        if (fallback.reason === "all_exhausted") {
          result = {
            ...result,
            error: allAccountsExhaustedMessage(info.name, fallback.earliestResetAt),
          };
        }
        break;
      }
      // Environment routes can survive the selector's exclude list.
      if (attemptedRouteIds.has(fallback.route.id)) break;
      console.warn(
        `[sub-agent] account-fallback session=${sessionId} spawn=${spawnId} agent=${subAgentId} `
        + `benched=${failedRoute.id} next=${fallback.route.id}`,
      );
      if (provisioned && credentialsDir) {
        if (sameHarness) {
          releaseSubAgentSpawnHome(credentialsDir, sessionId, spawnId);
        } else {
          if (failedRoute.kind === "account") {
            try {
              syncProviderAccountTokenBack(credentialsDir, sessionId, subAgentId, failedRoute.id);
            } catch {
              // Best-effort token sync.
            }
          }
          // Preserve rotations the normal publisher cannot order before the unconditional wipe.
          try {
            preserveBorrowedTokensBeforeWipe(
              credentialsDir,
              sessionId,
              subAgentId,
              failedRoute.kind === "account" ? failedRoute.id : undefined,
            );
          } catch {
            // Best-effort token preservation.
          }
          // Keep the borrow open across failover; release would lose the account to restore.
          removeSubAgentCredentials(credentialsDir, sessionId, subAgentId);
        }
      }
      route = fallback.route;
      accountId = route.kind === "account" ? route.id : undefined;
      attemptedRouteIds.add(route.id);
      await provisionAttempt();
      result = await spawn();
      exhausted = detectExhaustion(result);
    }
    // Some CLIs return quota notices as successful assistant text.
    if (exhausted && result.status === "success") {
      result = { ...result, status: "error", error: result.error ?? result.text.trim() };
    }

    const hasUsage =
      result.costUsd > 0 ||
      result.durationMs > 0 ||
      result.inputTokens !== undefined ||
      result.outputTokens !== undefined;
    if (hasUsage) {
      const consultCost = resolveTurnCost({
        harnessId: subAgentId,
        attribution: subAttribution,
        // The default zero is not a reported price; missing prices need token-based costing.
        reportedCostUsd: result.costReported ? result.costUsd : undefined,
        reportedCostSource: "per-turn",
        tokens: {
          input: result.inputTokens,
          output: result.outputTokens,
          cacheRead: result.cacheReadTokens,
          cacheWrite: result.cacheCreateTokens,
        },
      });
      deps.usageManager.record(
        sessionId,
        consultCost.costUsd,
        result.durationMs,
        result.inputTokens,
        result.outputTokens,
        {
          subAgentId,
          costSource: consultCost.costSource,
          model: spawnModel,
          ...(subAttribution ? { attribution: subAttribution } : {}),
          ...(result.cacheReadTokens !== undefined ? { cacheRead: result.cacheReadTokens } : {}),
          ...(result.cacheCreateTokens !== undefined ? { cacheCreate: result.cacheCreateTokens } : {}),
          ...(result.contextTokens !== undefined ? { contextTokens: result.contextTokens } : {}),
        },
      );
      emitSubAgentUsageUpdate(deps.usageManager, runner, sessionId);
    }

    if (result.rateLimits) {
      deps.recordAgentRateLimits?.(
        subAgentId,
        result.rateLimits.session,
        result.rateLimits.weekly,
        sessionId,
        route?.id,
      );
    }

    finalizeConsultCard({
      ...pendingCard,
      status: result.status,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      truncated: result.truncated,
      ...(result.status === "cancelled" ? { statusDetail: HOST_SHUTDOWN_CONSULT_DETAIL } : {}),
      ...(result.text ? { outputMarkdown: result.text } : {}),
    });

    return { ...result, subAgentId, spawnId };
  } catch (err) {
    const status: SubAgentConsultCard["status"] =
      err instanceof WorkerAbortedError ? "cancelled"
      : err instanceof WorkerTimeoutError ? "timeout"
      : "error";
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `[sub-agent] failed session=${sessionId} spawn=${spawnId} agent=${subAgentId} status=${status}: ${detail}`,
    );
    finalizeConsultCard({
      ...pendingCard,
      status,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      costUsd: 0,
      truncated: false,
      ...(status === "cancelled"
        ? {
          statusDetail: teardownConsultDetail(
            err instanceof WorkerAbortedError ? err.reason : undefined,
          ),
        }
        : {}),
    });
    throw err;
  } finally {
    if (provisioned && credentialsDir) {
      if (sameHarness) {
        releaseSubAgentSpawnHome(credentialsDir, sessionId, spawnId);
        console.log(
          `[sub-agent] release-spawn-home session=${sessionId} spawn=${spawnId} agent=${subAgentId} `
          + `account=${accountId ?? "flat"}`,
        );
      } else {
        try {
          if (accountId) syncProviderAccountTokenBack(credentialsDir, sessionId, subAgentId, accountId);
          else syncAgentTokenBack(credentialsDir, sessionId, subAgentId);
        } catch {
          // Best-effort token sync.
        }
        // Restore from the borrow record; the current marker belongs to the consult.
        const restoreAccountId = releaseSubAgentCredentials(credentialsDir, sessionId, subAgentId);
        console.log(
          `[sub-agent] wipe-credentials session=${sessionId} spawn=${spawnId} agent=${subAgentId} `
          + `account=${accountId ?? "flat"} restore=${restoreAccountId ?? "none"}`,
        );
        if (subAgentId === session.agentId && restoreAccountId) {
          provisionProviderAccountCredentials(
            credentialsDir,
            sessionId,
            subAgentId,
            restoreAccountId,
          );
        }
      }
    }

    // Wipe credentials before committing; commit before a result wake can start another turn.
    await commitSubAgentWork(
      {
        sessionManager: deps.sessionManager,
        runnerRegistry: deps.runnerRegistry,
        chatHistoryManager: deps.chatHistoryManager,
        ...(deps.createGitManager ? { createGitManager: deps.createGitManager } : {}),
      },
      sessionId,
      { spawnId, subAgentId },
    );

    // Delivery can boot a container; do not hold the caller's HTTP response open for it.
    if (terminalCard && deps.deliverConsultResult) {
      void deps
        .deliverConsultResult({ sessionId, card: terminalCard, originatingTurnEpoch })
        .catch((err: unknown) => {
          console.error(`[sub-agent] result delivery failed session=${sessionId} spawn=${spawnId}:`, err);
        });
    }
  }
}

export interface ConsultCardReader {
  listSubAgentConsultCards(sessionId: string): SubAgentConsultCard[];
}

export interface GetSubAgentResultDeps {
  chatHistoryManager: ConsultCardReader;
}

export function getSubAgentResult(
  deps: GetSubAgentResultDeps,
  sessionId: string,
  spawnId?: string,
): SubAgentConsultCard {
  const cards = deps.chatHistoryManager.listSubAgentConsultCards(sessionId);
  if (cards.length === 0) {
    throw new ServiceError(404, "No sub-agent runs in this session yet.");
  }
  // Legacy duplicate rows can leave a stale pending copy beside the terminal result.
  const preferTerminal = (matches: SubAgentConsultCard[]): SubAgentConsultCard => {
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].status !== "pending") return matches[i];
    }
    return matches[matches.length - 1];
  };
  if (!spawnId) {
    const latest = cards[cards.length - 1].spawnId;
    return preferTerminal(cards.filter((c) => c.spawnId === latest));
  }
  const exact = cards.filter((c) => c.spawnId === spawnId);
  if (exact.length > 0) return preferTerminal(exact);
  const prefixed = cards.filter((c) => c.spawnId.startsWith(spawnId));
  const runs = new Set(prefixed.map((c) => c.spawnId));
  if (runs.size === 1) return preferTerminal(prefixed);
  if (runs.size > 1) {
    throw new ServiceError(400, `Ambiguous run id "${spawnId}" — it matches ${runs.size} runs.`);
  }
  throw new ServiceError(404, `No sub-agent run with id "${spawnId}" in this session.`);
}

export const SUB_AGENT_RESULT_POLL_INTERVAL_MS = 500;

export const DEFAULT_SUB_AGENT_WAIT_MS = 5 * 60 * 1000;

export const MAX_SUB_AGENT_WAIT_MS = 30 * 60 * 1000;

export interface WaitForSubAgentResultOptions {
  spawnId?: string;
  // Bounded segments let the shim resume waiting after a transport reset.
  segmentMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WaitForSubAgentResultOutcome {
  card: SubAgentConsultCard;
  outcome: "finished" | "pending";
}

export async function waitForSubAgentResult(
  deps: GetSubAgentResultDeps,
  sessionId: string,
  opts: WaitForSubAgentResultOptions,
): Promise<WaitForSubAgentResultOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  let card = getSubAgentResult(deps, sessionId, opts.spawnId);
  if (card.status !== "pending") return { card, outcome: "finished" };

  // Do not switch to a newer run that starts during this wait.
  const pinnedSpawnId = card.spawnId;
  const deadline = now() + Math.max(0, opts.segmentMs);

  while (now() < deadline) {
    await sleep(Math.min(SUB_AGENT_RESULT_POLL_INTERVAL_MS, Math.max(0, deadline - now())));
    try {
      card = getSubAgentResult(deps, sessionId, pinnedSpawnId);
    } catch {
      // Retry transient history-read failures.
      continue;
    }
    if (card.status !== "pending") return { card, outcome: "finished" };
  }

  return { card, outcome: "pending" };
}

function emitSubAgentUsageUpdate(
  usageManager: UsageManager,
  runner: { emitMessage: (msg: WsServerMessage) => void },
  sessionId: string,
): void {
  const sessionUsage = usageManager.getSessionUsage(sessionId);
  if (!sessionUsage) return;
  const tokenTotals = usageManager.getSessionTokenTotals(sessionId);
  runner.emitMessage({
    type: "usage_update",
    sessionId,
    totals: sessionUsage.totals,
    groups: sessionUsage.groups ?? [],
    totalDurationMs: sessionUsage.totalDurationMs,
    turnCount: sessionUsage.turnCount,
    cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
    cumulativeOutputTokens: tokenTotals?.cumulativeOutputTokens,
    subAgent: true,
  });
}

export function sweepSubAgentCredentialsOnSignOut(
  agentId: AgentId,
  deps: { sessionManager: SessionManager; credentialsDir?: string },
): void {
  if (!deps.credentialsDir) return;
  for (const session of deps.sessionManager.list()) {
    if (session.agentId === agentId) continue;
    // Leave the borrow record for an in-flight run's finally to release.
    removeSubAgentCredentials(deps.credentialsDir, session.id, agentId);
  }
}
