/**
 * Sub-agent spawning service (docs/144).
 *
 * The orchestrator-side authority for the `shipit agent run` primitive: a
 * pinned session's agent spawns *any* registered agent with *any* prompt and
 * gets that agent's final text back, synchronously, within the same turn. The
 * spawned agent never becomes the session's agent — it runs as a one-shot
 * subprocess (over the worker's `/agent/spawn`, or in-process in local mode),
 * returns its text, and goes away.
 *
 * This service owns every load-bearing concern except the actual adapter run:
 * the global setting gate, auth/pin/recursion/per-turn-cap checks, lazy +
 * account-correct cross-agent credential provisioning, the transient spawn
 * chip, usage attribution to the sub-agent, and the token-sync-back + wipe in a
 * `finally`. The run itself is delegated to `runner.spawnSubAgent`.
 *
 * Review is the first *consumer* of this primitive, not the primitive itself:
 * "get a second opinion from Codex on this diff" is just a review-shaped prompt
 * handed to `subAgentId: "codex"`.
 *
 * ## Observability (SHI-278)
 *
 * Every line this module logs is prefixed `[sub-agent]`, matching the house
 * style of the paths around it (`[spawn-child]`, `[turn]`, `[steer-send]`,
 * `[container-runner:<sid>]`). This path was previously *completely silent* —
 * entry, all eight rejection gates, the exhaustion fallback, completion, and the
 * catch — so "Codex just didn't run" was undebuggable from host logs and one
 * incident had to be reconstructed from a git commit message. A silent 403/409
 * is the worst case: the user sees nothing and the logs say nothing.
 *
 * Sizes and ids only — never prompt or output text.
 */

import { randomUUID } from "node:crypto";
import type { AgentId, SubAgentConsultCard, WsServerMessage } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { UsageManager } from "../usage.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import {
  emitChatCard,
  persistCardTransition,
  type InProgressPersister,
} from "../chat-card-persistence.js";
import { WorkerAbortedError, WorkerTimeoutError } from "../worker-http.js";
import {
  provisionSubAgentCredentials,
  provisionProviderAccountCredentials,
  removeSubAgentCredentials,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
} from "../session-credentials.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import { detectHardExhaustion, exhaustionLockoutUntil } from "../ws-handlers/agent-rate-limits.js";
import { ServiceError } from "./types.js";

/** §5 — modest per-turn fan-out cap; the forgery-resistant bound on total spawns. */
export const SUB_AGENT_PER_TURN_CAP = 3;

/**
 * SHI-278 — the chat-history surface the consult card's lifecycle needs: the
 * in-progress replace `emitChatCard` uses to persist the PENDING card, plus the
 * finalized-row patch that flips it to its terminal status once the run ends
 * (usually after the originating turn has finalized, since docs/236 tells agents
 * to background long consults).
 */
export interface ConsultCardPersister extends InProgressPersister {
  updateSubAgentConsultCard(
    sessionId: string,
    cardId: string,
    patch: Partial<SubAgentConsultCard>,
  ): boolean;
}

/**
 * SHI-278 — log a rejected spawn and build the error the route maps to HTTP.
 * Every gate goes through here so no rejection can be silent; `reason` is a
 * stable grep token, distinct from the user-facing message.
 */
function rejectSpawn(
  sessionId: string,
  subAgentId: AgentId,
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
  sessionManager: SessionManager;
  credentialStore: CredentialStore;
  agentRegistry: AgentRegistry;
  providerAccountManager?: ProviderAccountManager;
  runnerRegistry: SessionRunnerRegistry;
  usageManager: UsageManager;
  /**
   * Where the consult card is persisted (docs/144 §7). Required so the card can't
   * ship emit-only and vanish on a switch/reload — `emitChatCard` takes a persist
   * context by construction (CLAUDE.md side-channel-card contract). SHI-278 also
   * needs the finalized-row patch for the pending → terminal transition.
   */
  chatHistoryManager: ConsultCardPersister;
  /**
   * Forward the sub-agent's latest subscription rate-limit snapshot into the
   * right `LimitsProvider` so the limit pill reflects quota the consult
   * consumed (docs/144). Mirrors the WS turn path's `recordAgentRateLimits`.
   * Optional — test contexts and runtimes without a `LimitsRegistry` omit it.
   */
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
    /**
     * docs/150 — the session whose turn reported these numbers, so the
     * orchestrator can attribute them to that session's pinned provider
     * account. Omitted only where no session owns the turn.
     */
    sessionId?: string,
  ) => void;
  /** Source-of-truth credentials root (`/credentials`). Omitted in local mode / tests. */
  credentialsDir?: string;
}

export interface RunSubAgentInput {
  subAgentId: AgentId;
  prompt: string;
  /**
   * The caller's recursion depth, forwarded from the shim's inherited
   * `SHIPIT_AGENT_DEPTH` (absent ⇒ 0, i.e. a primary). A non-zero depth means
   * the caller is itself a spawned sub-agent — rejected by the best-effort
   * recursion guard.
   */
  depth: number;
}

export interface RunSubAgentResult extends SubAgentRunResult {
  subAgentId: AgentId;
  /**
   * SHI-245 — the run's id, echoed back to the caller. The SAME id is on the
   * consult card the UI renders, so the text the invoking agent acted on and the
   * text the user read are provably one artifact, and either side can name the
   * run when they disagree. It is also the handle for `shipit agent result <id>`,
   * which re-reads the persisted card — the recovery path when the caller's copy
   * was lost (a SIGTERMed shim, a foreground tool timeout).
   */
  spawnId: string;
}

function allAccountsExhaustedMessage(providerName: string, earliestResetAt: string | null): string {
  const reset = earliestResetAt
    ? ` Earliest reset: ${new Date(earliestResetAt).toISOString()}.`
    : "";
  return `Every connected ${providerName} subscription account is out of quota.${reset}`;
}

/**
 * Run a one-shot sub-agent on behalf of a pinned session's primary agent and
 * return its final assistant text. Throws {@link ServiceError} for every
 * authorization failure so the route maps it to the right HTTP status (the
 * shim turns those into a clear, non-zero `shipit agent` exit).
 */
export async function runSubAgent(
  deps: RunSubAgentDeps,
  sessionId: string,
  input: RunSubAgentInput,
): Promise<RunSubAgentResult> {
  const { subAgentId, prompt, depth } = input;
  const promptBytes = typeof prompt === "string" ? Buffer.byteLength(prompt) : 0;
  console.log(
    `[sub-agent] requested session=${sessionId} agent=${subAgentId} depth=${depth} promptBytes=${promptBytes}`,
  );

  const session = deps.sessionManager.get(sessionId);
  if (!session) throw rejectSpawn(sessionId, subAgentId, 404, "session_not_found", "Session not found");

  // §1 — the global gate, checked on EVERY spawn (not cached at boot) so toggling
  // it off mid-session takes effect on the next attempt.
  if (!deps.credentialStore.getEnableSubAgents()) {
    throw rejectSpawn(sessionId, subAgentId, 403, "sub_agents_disabled",
      "Sub-agents are disabled. Enable them in Settings → Multi-agent sessions.");
  }

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw rejectSpawn(sessionId, subAgentId, 400, "empty_prompt",
      "A prompt is required (pass it via --prompt-file -).");
  }

  // §3 — the agent must be registered and authed. Re-probe first so a just-
  // -completed sign-in is seen.
  deps.agentRegistry.refreshAuth(subAgentId);
  const info = deps.agentRegistry.get(subAgentId);
  if (!info) throw rejectSpawn(sessionId, subAgentId, 400, "unknown_agent", `Unknown agent: ${subAgentId}`);
  if (!info.authConfigured) {
    throw rejectSpawn(sessionId, subAgentId, 400, "not_signed_in",
      `${info.name} is not signed in. Connect it in Settings before spawning it.`);
  }

  // §3 — a pre-pin session has no primary identity to spawn on behalf of.
  if (!session.agentPinned) {
    throw rejectSpawn(sessionId, subAgentId, 409, "session_not_pinned",
      "This session has no pinned agent yet — send a message first.");
  }

  // §3 — best-effort recursion guard. A non-zero forwarded depth means the
  // caller is a spawned sub-agent. NOT forgery-resistant (a shell-capable
  // sub-agent can spoof depth: 0); the per-turn cap below is the real bound.
  if (depth !== 0) {
    throw rejectSpawn(sessionId, subAgentId, 403, "recursion_depth",
      "Sub-agents cannot spawn further sub-agents.");
  }

  const runner = deps.runnerRegistry.get(sessionId);
  if (!runner) {
    throw rejectSpawn(sessionId, subAgentId, 409, "session_inactive", "Session is not active.");
  }

  // §5 — the forgery-resistant per-turn cap. Keyed by the worker-injected
  // SESSION_ID (this runner), so every spawn in the turn — including any a
  // sub-agent forges past the depth guard — decrements the same budget.
  if (runner.subAgentSpawnsThisTurn >= SUB_AGENT_PER_TURN_CAP) {
    throw rejectSpawn(sessionId, subAgentId, 429, "per_turn_cap",
      `Sub-agent spawn cap reached for this turn (max ${SUB_AGENT_PER_TURN_CAP}).`);
  }
  runner.subAgentSpawnsThisTurn += 1;

  // §4 — resolve the sub-agent's provider-account route exactly as the primary
  // turn path does, so a multi-account user provisions from the freshest account
  // root rather than the stale flat root.
  const selection = deps.providerAccountManager?.selectAccountForTurn(subAgentId);
  if (selection && !selection.ok) {
    if (selection.reason === "all_exhausted") {
      throw rejectSpawn(sessionId, subAgentId, 429, "all_accounts_exhausted",
        allAccountsExhaustedMessage(info.name, selection.earliestResetAt));
    }
    throw rejectSpawn(sessionId, subAgentId, 400, "no_account_route",
      `${info.name} is not signed in. Connect it in Settings before spawning it.`);
  }
  let route = selection?.route ?? null;
  let accountId = route?.kind === "account" ? route.id : undefined;

  // A same-provider spawn reuses the pinned agent's already-present credentials
  // and provisions nothing. A cross-provider spawn provisions the other agent's
  // subtree — only on a container runner (local mode is a no-op, docs/138).
  const isContainer = runner instanceof ContainerSessionRunner;
  const provisioned = isContainer && !!deps.credentialsDir;
  const credentialsDir = deps.credentialsDir;

  const provisionAttempt = (): void => {
    if (provisioned && credentialsDir) {
      console.log(
        `[sub-agent] provision-credentials session=${sessionId} agent=${subAgentId} account=${accountId ?? "flat"}`,
      );
      provisionSubAgentCredentials(credentialsDir, sessionId, subAgentId, accountId);
    }
  };
  provisionAttempt();

  const spawnId = randomUUID();
  const cardId = randomUUID();
  const startedAtMs = Date.now();
  // §7 — transient "Asking Codex…" spinner (live activity only) while in flight.
  // Kept for the live case (it renders pinned at the bottom of the transcript
  // rather than inline), but SHI-278 it is no longer the ONLY in-flight signal —
  // the pending card below is the durable one.
  runner.emitMessage({ type: "sub_agent_spawn", sessionId, spawnId, subAgentId });

  // docs/217 — a sub-agent runs with the invoked agent's OWN global defaults
  // (reasoning effort + model, set on its Settings tab), independent of the
  // caller's session composer value. Resolved per spawn so a Settings change
  // applies next time. An unset model lets the adapter pick `models[0]`.
  const { reasoningEffort, model } = deps.credentialStore.getAgentSubAgentDefaults(subAgentId);

  console.log(
    `[sub-agent] accepted session=${sessionId} spawn=${spawnId} card=${cardId} agent=${subAgentId} `
    + `depth=${depth} promptBytes=${promptBytes} route=${route?.kind ?? "default"}:${accountId ?? "-"} `
    + `model=${model ?? "default"} effort=${reasoningEffort ?? "default"} `
    + `spawnsThisTurn=${runner.subAgentSpawnsThisTurn}`,
  );

  // §7 / SHI-278 — the DURABLE in-flight record. Emitted `pending` at spawn time
  // via `emitChatCard` (CLAUDE.md side-channel-card contract: live WS + in-band
  // record anchored at the spawn's group index + immediate persist), then patched
  // to its terminal status when the run ends. Creating it here rather than at
  // completion is what makes a backgrounded consult survive a session switch, a
  // reload, and a container restart — the incident where a 15-minute Codex review
  // left no trace anywhere. It also anchors the card at the CALL SITE instead of
  // wherever the transcript happened to be when the consult finished (the
  // positional drift docs/144 §7 noted for backgrounded runs).
  const pendingCard: SubAgentConsultCard = {
    cardId,
    spawnId,
    subAgentId,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  emitChatCard(
    runner,
    { type: "sub_agent_consult_card", sessionId, card: pendingCard },
    { role: "assistant", text: "", subAgentConsult: pendingCard },
    { chatHistoryManager: deps.chatHistoryManager, sessionId },
  );

  /**
   * Flip the pending card to its terminal status. Two hazards this navigates,
   * both from the incident:
   *
   *  - **The runner may be gone.** A restart/destroy disposes the runner that
   *    started the consult; emitting through it drops the live card (no attached
   *    viewers) AND `persistTurnInProgress` would rebuild `in_progress=1` rows
   *    from its stale turn state, which the next turn then clobbers. So the
   *    runner is RE-RESOLVED from the registry at completion time.
   *  - **The originating turn is usually over.** docs/236 made backgrounding the
   *    recommended shape, so the common case is a card whose turn already
   *    finalized. `persistCardTransition` handles exactly that split: patch the
   *    recorded card while the turn still holds it, else patch the finalized DB
   *    row directly.
   */
  const finalizeConsultCard = (card: SubAgentConsultCard) => {
    const live = deps.runnerRegistry.get(sessionId) ?? runner;
    live.emitMessage({ type: "sub_agent_consult_card", sessionId, card });
    let persisted = true;
    persistCardTransition(
      live,
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
      (m) => m.subAgentConsult?.cardId === cardId,
      (m) => ({ ...m, subAgentConsult: card }),
      () => { persisted = deps.chatHistoryManager.updateSubAgentConsultCard(sessionId, cardId, card); },
    );
    console.log(
      `[sub-agent] finished session=${sessionId} spawn=${spawnId} card=${cardId} agent=${subAgentId} `
      + `status=${card.status} durationMs=${card.durationMs ?? 0} costUsd=${card.costUsd ?? 0} `
      + `outputChars=${card.outputMarkdown?.length ?? 0} truncated=${card.truncated === true} `
      + `emitted=true persisted=${persisted} liveRunner=${live === runner ? "original" : "reresolved"}`,
    );
  };

  try {
    const spawn = () => runner.spawnSubAgent({
      agentId: subAgentId,
      prompt,
      spawnId,
      depth,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(model !== undefined ? { model } : {}),
    });
    let result = await spawn();

    // docs/150 reqs 7, 14, 20 — one-shot reviews use the same persisted hard-
    // exhaustion signal and structured account router as ordinary turns. One
    // fallback is bounded by the connected subscription set: every account is
    // attempted at most once. API-key routes never enter this branch because
    // only account routes are benched or accepted as fallbacks.
    const attemptedAccountIds = new Set(accountId ? [accountId] : []);
    let exhausted = result.status === "error" && result.error
      ? detectHardExhaustion(result.error)
      : null;
    while (exhausted && accountId && deps.providerAccountManager) {
      const failedAccountId = accountId;
      deps.providerAccountManager.markAccountExhausted(
        subAgentId,
        failedAccountId,
        exhaustionLockoutUntil(exhausted),
      );
      const fallback = deps.providerAccountManager.selectAccountForTurn(subAgentId, {
        exclude: [...attemptedAccountIds],
      });
      if (!fallback.ok) {
        console.warn(
          `[sub-agent] account-fallback-exhausted session=${sessionId} spawn=${spawnId} `
          + `agent=${subAgentId} benched=${failedAccountId} reason=${fallback.reason}`,
        );
        if (fallback.reason === "all_exhausted") {
          result = {
            ...result,
            error: allAccountsExhaustedMessage(info.name, fallback.earliestResetAt),
          };
        }
        break;
      }
      if (fallback.route.kind !== "account") break;
      console.warn(
        `[sub-agent] account-fallback session=${sessionId} spawn=${spawnId} agent=${subAgentId} `
        + `benched=${failedAccountId} next=${fallback.route.id}`,
      );
      if (provisioned && credentialsDir) {
        try {
          syncProviderAccountTokenBack(credentialsDir, sessionId, subAgentId, failedAccountId);
        } catch {
          // Best-effort, matching the terminal sync below.
        }
        removeSubAgentCredentials(credentialsDir, sessionId, subAgentId);
      }
      route = fallback.route;
      accountId = route.id;
      attemptedAccountIds.add(accountId);
      provisionAttempt();
      result = await spawn();
      exhausted = result.status === "error" && result.error
        ? detectHardExhaustion(result.error)
        : null;
    }

    // §5 — attribute the sub-agent's cost AND token usage to subAgentId, not the
    // pinned agentId. A subscription backend (Codex) reports tokens but $0 cost,
    // so gate on any telemetry — cost, duration, or tokens — not cost alone.
    const hasUsage =
      result.costUsd > 0 ||
      result.durationMs > 0 ||
      result.inputTokens !== undefined ||
      result.outputTokens !== undefined;
    if (hasUsage) {
      deps.usageManager.record(
        sessionId,
        result.costUsd,
        result.durationMs,
        result.inputTokens,
        result.outputTokens,
        {
          subAgentId,
          ...(result.cacheReadTokens !== undefined ? { cacheRead: result.cacheReadTokens } : {}),
          ...(result.cacheCreateTokens !== undefined ? { cacheCreate: result.cacheCreateTokens } : {}),
          ...(result.contextTokens !== undefined ? { contextTokens: result.contextTokens } : {}),
        },
      );
      // Refresh the live bill (cost pill + cumulative tokens). The normal turn
      // path emits this from `agent-listeners`; a consult runs outside that
      // path, so without it the recorded usage never reaches the UI until a
      // reload. Flagged `subAgent` so it updates the rollups but leaves the
      // context dial — the pinned agent's window — untouched. Transport-only;
      // the DB row is the persistence (rehydrated via GET /history).
      emitSubAgentUsageUpdate(deps.usageManager, runner, sessionId);
    }

    // §5 — the consult drew down the sub-agent's subscription quota. Its
    // `agent_rate_limits` events are confined to the one-shot adapter, so
    // forward the carried-back snapshot into that agent's limits provider —
    // otherwise the pill stays stale until the next primary turn for that agent.
    if (result.rateLimits) {
      deps.recordAgentRateLimits?.(subAgentId, result.rateLimits.session, result.rateLimits.weekly);
    }

    finalizeConsultCard({
      ...pendingCard,
      status: result.status,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      truncated: result.truncated,
      // docs/220 — carry the verbatim output so the brokered consult is visible,
      // not just attested. Already capped upstream (`maxOutputChars`), which is
      // also what flags `truncated`. Omitted when empty.
      //
      // SHI-245 — this is the SAME `result.text` returned below to the invoking
      // agent, by construction: one string, written to both surfaces from one
      // place. Never re-derive the card's copy from anything else — a second
      // extraction is exactly how the two documents drift apart.
      ...(result.text ? { outputMarkdown: result.text } : {}),
    });

    return { ...result, subAgentId, spawnId };
  } catch (err) {
    // A transport-level failure never produced a result, so finalize the card
    // from the error itself — otherwise the card stays pending forever. An
    // ABORT means someone tore the runner down under us (Restart agent, idle
    // dispose, full reset), which is a cancellation, not a fault; a transport
    // TIMEOUT means the worker never answered at all (SHI-278's backstop).
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
    });
    throw err;
  } finally {
    // §4 — token-sync-back THEN wipe, both targeting the same resolved account
    // root. Runs on success, failure, crash, or cancel. Skipped for a
    // same-provider spawn (no window opened) and in local mode.
    if (provisioned && credentialsDir) {
      try {
        if (accountId) syncProviderAccountTokenBack(credentialsDir, sessionId, subAgentId, accountId);
        else syncAgentTokenBack(credentialsDir, sessionId, subAgentId);
      } catch {
        // Best-effort: a failed sync-back at worst makes the next provision
        // start from a slightly older token, which heals on its own refresh.
      }
      removeSubAgentCredentials(credentialsDir, sessionId, subAgentId);
      console.log(
        `[sub-agent] wipe-credentials session=${sessionId} spawn=${spawnId} agent=${subAgentId} `
        + `account=${accountId ?? "flat"}`,
      );
      // A same-provider consult temporarily borrows the session's provider
      // subtree while the primary is blocked waiting for it. Put the pinned
      // account back before the primary resumes; cross-provider runs touched a
      // different subtree, so there is nothing to restore.
      if (
        subAgentId === session.agentId
        && session.providerRouteKind === "account"
        && session.providerRouteId
      ) {
        provisionProviderAccountCredentials(
          credentialsDir,
          sessionId,
          subAgentId,
          session.providerRouteId,
        );
      }
    }
  }
}

/**
 * Minimal chat-history surface the result lookup needs. Kept structural so
 * tests and non-`ChatHistoryManager` callers can pass a stub.
 */
export interface ConsultCardReader {
  listSubAgentConsultCards(sessionId: string): SubAgentConsultCard[];
}

export interface GetSubAgentResultDeps {
  chatHistoryManager: ConsultCardReader;
}

/**
 * SHI-245 — re-read a completed spawn's persisted consult card: the exact
 * artifact rendered in the UI, output text included.
 *
 * Backs `shipit agent result [<runId>]`. Two things make this worth a route of
 * its own rather than "the agent already got the text on stdout":
 *
 *  - **Parity is checkable.** The caller can prove its copy is the user's copy
 *    instead of assuming it, and can name a run id when the two disagree.
 *  - **The result outlives the call.** A `shipit agent run` whose shim dies —
 *    the invoking agent's foreground tool timeout SIGTERMs it well before a long
 *    consult finishes — does not stop the spawn; it finishes server-side and
 *    persists its card. Without this, that output existed only in the UI and the
 *    18 minutes of work were unrecoverable from the agent's side.
 *
 * Omit `spawnId` for the session's most recent run.
 *
 * SHI-278 — a card can now be `pending` (created at spawn time). That is
 * returned as-is rather than skipped: "the consult you named is still running"
 * is the honest answer, and hiding it would resurrect the older, more confusing
 * failure where a live run looked like it had never existed.
 */
export function getSubAgentResult(
  deps: GetSubAgentResultDeps,
  sessionId: string,
  spawnId?: string,
): SubAgentConsultCard {
  const cards = deps.chatHistoryManager.listSubAgentConsultCards(sessionId);
  if (cards.length === 0) {
    throw new ServiceError(404, "No sub-agent runs in this session yet.");
  }
  if (!spawnId) return cards[cards.length - 1];
  // Accept a unique prefix too: the id is printed as a short prefix in the run
  // footer, and re-typing a full UUID from a log line is a needless failure mode.
  const exact = cards.find((c) => c.spawnId === spawnId);
  if (exact) return exact;
  const prefixed = cards.filter((c) => c.spawnId.startsWith(spawnId));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new ServiceError(400, `Ambiguous run id "${spawnId}" — it matches ${prefixed.length} runs.`);
  }
  throw new ServiceError(404, `No sub-agent run with id "${spawnId}" in this session.`);
}

/**
 * Emit a `usage_update` reflecting a just-recorded sub-agent turn (docs/144).
 * Rolls the consult's cost + tokens into the session bill and cumulative-token
 * totals — both are SUM queries over every row, so they already include the new
 * sub-agent row. Flagged `subAgent: true` so the client updates those rollups
 * but skips the context dial (the pinned agent's window, not the consult's).
 */
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
    totalCostUsd: sessionUsage.totalCostUsd,
    totalDurationMs: sessionUsage.totalDurationMs,
    turnCount: sessionUsage.turnCount,
    cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
    cumulativeOutputTokens: tokenTotals?.cumulativeOutputTokens,
    subAgent: true,
  });
}

/**
 * §4 — sign-out sweep. When the user signs out of `agentId`, drop any in-flight
 * cross-agent credential subtree provisioned for a spawn from sessions where
 * `agentId` is NOT the pinned agent, so a sub-agent's creds never outlive the
 * user's authorization. Wired to {@link AgentRegistry}'s `sign-out` event.
 */
export function sweepSubAgentCredentialsOnSignOut(
  agentId: AgentId,
  deps: { sessionManager: SessionManager; credentialsDir?: string },
): void {
  if (!deps.credentialsDir) return;
  for (const session of deps.sessionManager.list()) {
    if (session.agentId === agentId) continue; // it's the pinned agent here — leave it
    removeSubAgentCredentials(deps.credentialsDir, session.id, agentId);
  }
}
