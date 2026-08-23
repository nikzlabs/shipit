/**
 * docs/252 phase 7 (req 9) — **running the work ShipIt does outside a turn**.
 *
 * `non-turn-model.ts` decides *what* to run on; this module runs it, records
 * what it cost, and says so when it fails. Three concerns, and the second and
 * third are the ones the requirement is emphatic about:
 *
 * ## 1. The execution path already existed
 *
 * Session naming shells out to a local CLI and only needed the resolved triple
 * threaded through (`session-namer.ts`). Pull-request description generation
 * had **no agent at all in production**: the orchestrator lives outside session
 * containers, so the default text generator returned the empty string and the
 * feature degraded silently (`app-di.ts`). Req 9 calls that half a *change*,
 * not a preserved behaviour.
 *
 * The fix is not a new spawn surface. `runner.spawnSubAgent` already posts to
 * the worker's `/agent/spawn`, runs a fresh adapter **outside** the resident
 * agent slot, and returns the accumulated text over the HTTP response — with an
 * in-process twin for `RUNTIME_MODE=local`. It is HTTP-only as CLAUDE.md
 * requires, and it is what `shipit agent run` already uses. It also solves the
 * lifecycle problem for free: an in-flight spawn registers in `_subAgentAborts`
 * and feeds `agentBusy`, so a generation in progress is already protected from
 * idle reclamation.
 *
 * Deliberately NOT `runSubAgent` (`services/sub-agent.ts`), which is the
 * user-facing `shipit agent run` primitive: that path is gated on the
 * "Multi-agent sessions" setting, on a pinned session agent, and on a per-turn
 * spawn cap — none of which describe ShipIt writing its own PR description.
 *
 * ## 2. Non-turn work spends money, so this phase records it
 *
 * A user can point session naming at a metered service and be charged for every
 * session they create. Naming used to discard its telemetry entirely, and the
 * brokered spawn returns a result whose recording happens one level up in the
 * sub-agent service — so the recording was at the wrong level, not absent. Both
 * halves now write a usage row with their own attribution, through the same
 * `turn-attribution.ts` rule the two turn writers share, so a naming turn and a
 * session turn on one credential cannot disagree about what a token costs.
 *
 * The row is written with `subAgentId` set to the derived harness. That is what
 * it is — a one-shot spawn of that harness, not the pinned agent's turn — and it
 * keeps the delta chain (`usage.record`, keyed by `(session, subAgentId)`) away
 * from the primary conversation's running total, and the consult out of the
 * context dial.
 *
 * **A row is written only when the harness reported telemetry.** A row with no
 * tokens would price at $0 through the rates, which is a *wrong* number rather
 * than a missing one — precisely the trap the cost rule's docstring is written
 * to avoid. A container-less PR generation attributes to the session whose PR
 * it is.
 *
 * Some non-turn work resolves **no model at all** — naming falling back when
 * nothing is eligible runs the session's own harness with no service, no
 * billing mode and therefore no rate table. Its tokens are real and its
 * attribution does not exist, so req 16 puts it in the legacy group: recorded
 * for its volume, and never priced. Not priced from rates, because there are
 * none; and not from the harness's own dollar figure either, which is the
 * default `resolveTurnCost` applies with no attribution — Codex reports none at
 * all, so that route lands the row at `$0` and asserts the run was free. See
 * {@link recordNonTurnUsage}.
 *
 * ## 3. Failure is never silent and never blocking
 *
 * The surrounding operation always completes with a fallback — a placeholder
 * session title, a generic PR description — and the user gets a **dismissible,
 * persisted** notice naming the service that failed. Persisted, not emitted:
 * naming is fire-and-forget and routinely finishes with the user on another
 * session or no viewer attached at all, which is exactly the case a transient
 * message cannot reach. Dismissal is state on the row (`dismissedAt`), so "I
 * read this" and "it never happened" stay distinguishable.
 */

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

/**
 * Wall-clock cap on a non-turn spawn. Far below the sub-agent default (30
 * minutes): nobody is waiting on a session title for half an hour, and a PR
 * description that has not arrived in three minutes is better replaced by the
 * generic fallback than left holding the create call open.
 */
export const NON_TURN_SPAWN_TIMEOUT_MS = 3 * 60_000;

/** Output cap. A PR description is prose, not a transcript. */
export const NON_TURN_MAX_OUTPUT_CHARS = 8_000;

/** The chat-history surface the notice needs: persist on emit, patch on dismiss. */
export interface NonTurnFailurePersister extends InProgressPersister {
  updateNonTurnFailureCard(
    sessionId: string,
    cardId: string,
    patch: Partial<NonTurnFailureCard>,
  ): boolean;
}

export interface NonTurnWorkDeps {
  credentialStore: CredentialStore;
  providerAccountManager?: ProviderAccountManager | undefined;
  /**
   * Lazily resolved: the generator is constructed before the runner registry it
   * spawns through (the registry is handed this generator as `generateText`).
   * The same lazy-holder shape `getPrStatusPoller` already uses.
   */
  getRunnerRegistry: () => SessionRunnerRegistry | undefined;
  chatHistoryManager: NonTurnFailurePersister;
  usageManager?: UsageManager | undefined;
  /**
   * Source-of-truth credentials root (`/credentials`). Omitted in local mode and
   * in tests, where credential provisioning is a no-op (docs/138).
   *
   * Required for the case cross-backend review found: non-turn work is chosen
   * **independently of the session**, so its derived harness is routinely not
   * the session's, and its account is routinely not the one the session's
   * container holds. Without provisioning, an account-backed background model
   * spawns against missing or stale credentials — and Anthropic's subscription
   * is the FIRST catalogue row, so that is the default install rather than a
   * corner.
   */
  credentialsDir?: string | undefined;
  /**
   * The session's own pinned account, so a same-harness spawn can put it back
   * after borrowing the subtree. Mirrors `runSubAgent`'s restore step.
   */
  sessionManager?: Pick<SessionManager, "get"> | undefined;
}

/** What a harness reported back about a non-turn run, when it reported anything. */
export interface NonTurnTelemetry {
  durationMs: number;
  /** The harness's own dollar figure, or `undefined` when it reported none. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

/**
 * Record what a non-turn run consumed, against the session it was done for.
 *
 * Two shapes, and the difference is whether a model resolved at all:
 *
 * - **A resolved target** carries a service, a billing mode and the rates the
 *   catalogue holds for that model, so the row is attributed and priced under
 *   `turn-attribution.ts`'s rule — the same one the two turn writers share.
 * - **No target** is the `nothing_eligible` fallback (`non-turn-model.ts`): the
 *   session's own harness, no service, no billing mode, no rate table. Req 16
 *   puts that row in the legacy group — all six attribution columns NULL, which
 *   the table's `CHECK` already makes the only expressible shape — and it is
 *   **unpriced**: `cost_usd` is a hard zero rather than anything derived. It is
 *   volume whose attribution is unknown, not spend.
 *
 * The unpriced rule is deliberate and is why this does not simply hand
 * `attribution: undefined` to {@link resolveTurnCost}, whose no-attribution
 * default is the harness's own dollar figure. Codex reports none, so that
 * default writes `$0` under the name of a measurement — the trap this feature
 * has hit twice already (a metered consult recorded as free in phase 3, Codex's
 * absent telemetry in phase 6). A zero written *because there is no price* is a
 * different fact from a zero written *because the price was zero*, and only the
 * first is true here; what keeps it from reading as the second is that the row
 * carries no rates, so no reader can turn it into a figure.
 *
 * A no-op when the harness reported nothing at all: an all-zero row priced from
 * the catalogue's rates says "this was free", which is a claim, not an absence.
 * The caller logs the gap instead. An unattributed run needs *tokens*
 * specifically — its dollar figure is never consulted, so a run reporting only
 * a cost has nothing left to record.
 */
export function recordNonTurnUsage(
  deps: Pick<NonTurnWorkDeps, "usageManager">,
  args: {
    sessionId: string;
    /**
     * The harness that actually ran it — `target.harnessId` when a model
     * resolved, the session's own harness when none did. Stored as
     * `subAgentId`, so it is required even in the unattributed case.
     */
    harnessId: AgentId;
    /** Absent when the run resolved no model: req 16's legacy group. */
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
        // Already this run's own cost — a one-shot spawn has no running
        // conversation total to diff against. Saying so explicitly is what keeps
        // `record()` from inferring `cumulative` and subtracting a prior snapshot.
        reportedCostSource: "per-turn",
        tokens: {
          input: telemetry.inputTokens,
          output: telemetry.outputTokens,
          cacheRead: telemetry.cacheReadTokens,
          cacheWrite: telemetry.cacheCreateTokens,
        },
      })
    // Unattributed: nothing to price against, and the harness's own figure is
    // not a substitute. `per-turn` keeps `record()` from treating this zero as
    // a cumulative baseline the next run of the same harness would diff against.
    : { costUsd: 0, costSource: "per-turn" as const };
  usageManager.record(
    args.sessionId,
    cost.costUsd,
    telemetry.durationMs,
    telemetry.inputTokens,
    telemetry.outputTokens,
    {
      // It IS a spawn of this harness rather than the pinned agent's turn, which
      // is what keeps it out of the primary delta chain and out of the context
      // dial (`usage.record`, `emitSubAgentUsageUpdate`).
      subAgentId: harnessId,
      costSource: cost.costSource,
      // No selection means no model id to record either. The split's model list
      // simply omits it — inventing the harness's default would be the same
      // guess the legacy group exists to refuse.
      ...(target ? { model: target.selection.modelId } : {}),
      ...(attribution ? { attribution } : {}),
      ...(telemetry.cacheReadTokens !== undefined ? { cacheRead: telemetry.cacheReadTokens } : {}),
      ...(telemetry.cacheCreateTokens !== undefined ? { cacheCreate: telemetry.cacheCreateTokens } : {}),
    },
  );
}

/** What ShipIt did instead, per purpose — the fallback the notice reports. */
const FALLBACK_TEXT: Record<NonTurnPurpose, string> = {
  "session-naming": "The session kept its placeholder title.",
  "pr-description": "The pull request got a generic description.",
};

/**
 * Surface a non-turn failure into `sessionId`'s transcript, durably.
 *
 * `emitChatCard` when a runner exists (live render + in-band record + persist);
 * a direct `append` when it does not, which is a real case here — naming can
 * finish after the session's container has gone away, and the notice must
 * survive that rather than depend on it.
 */
export function emitNonTurnFailure(
  deps: Pick<NonTurnWorkDeps, "getRunnerRegistry" | "chatHistoryManager">,
  args: {
    sessionId: string;
    purpose: NonTurnPurpose;
    /** The resolved target, when one resolved and then failed at run time. */
    target?: NonTurnTarget | undefined;
    /** The service named by a pin the install can no longer run. */
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
    // No runner to emit through — the session's container is gone, or it never
    // had one. The row is still written, which is the whole point of the notice
    // being transcript content: the user finds it the next time they open the
    // session rather than never.
    deps.chatHistoryManager.append(sessionId, persisted);
  }
  console.warn(
    `[non-turn] ${purpose} failed session=${sessionId} `
    + `service=${named?.serviceId ?? "-"}/${named?.billingMode ?? "-"} `
    + `model=${named?.modelId ?? "-"}: ${args.detail ?? "no detail"}`,
  );
  return card;
}

/**
 * Mark a notice dismissed. Patches the persisted row and broadcasts, so a second
 * attached viewer stops showing it too. Returns false when no such card exists.
 *
 * Through `persistCardTransition`, never a bare `updateNonTurnFailureCard`. The
 * card can be recorded on a RUNNING turn — naming finishes inside the session's
 * first turn more often than not — and `recordedCards` is not cleared until the
 * next turn starts, so a database-only patch is rebuilt away when that turn
 * finalizes and the notice reappears on the next reload. That is the recurring
 * clobber docs/164, docs/177 and docs/193 each hit; cross-backend review caught
 * this one before it shipped.
 */
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
 * Build the production `generateText`: resolve req 9's model, run it through
 * the session's brokered one-shot spawn, record the usage, and surface a durable
 * notice on failure.
 *
 * Returns the empty string on every failure path rather than throwing. That is
 * deliberate and it is what makes the two halves symmetric: the caller's job is
 * to normalize a blank generation into its own fallback (`github.ts` does), and
 * a background failure must never block the operation around it.
 *
 * `fallback` is the pre-feature generator — app-di's in-process one in local
 * mode, a test's stub, and the degrade-to-empty default otherwise. It runs in
 * exactly two cases: a call with **no session** (the post-interrupt commit
 * message, which has nothing to attribute to and no notice to raise), and an
 * install with **no eligible model at all**, where req 9's rule has no answer to
 * apply and refusing to run would be a regression rather than a policy. It is
 * never consulted when a model WAS chosen and then failed — that is the
 * dependency req 9 exists to remove, and the notice is what reports it.
 */
export function makeNonTurnGenerateText(
  // `GenerateText` rather than `(prompt, cwd) => …`: the fallback needs `opts`
  // so it can record its own usage row when it actually spends tokens (see the
  // `nothing_eligible` branch below and `app-di.ts`).
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
    // **Nothing eligible is "ShipIt has no opinion", not "do not run".** The
    // requirement's default is about choosing among models the install can run;
    // with none to choose from there is no choice to make, and refusing to run
    // would be a regression rather than a policy. `listConfiguredCredentials`
    // sees the credential store and the environment — not a CLI logged in on
    // the host outside both — so a dev checkout and a hand-authenticated
    // deployment both land here, and both named their sessions perfectly well
    // before this feature. So fall back to exactly what they did before.
    //
    // A stale PIN is the opposite case and keeps its hard stop below: there the
    // user chose a service and it went away, which is precisely what req 9's
    // notice reports on.
    //
    // Req 16 wants that fallback's tokens in the legacy group too, and this
    // function is the wrong place to write them: the fallback is a black box
    // returning a string, and only IT knows whether a CLI ran. In container
    // production none does (there is no in-process agent, so the call returns
    // "" and costs nothing); in `RUNTIME_MODE=local` one does. So `opts` is
    // forwarded and the recording lives with the producer, in `app-di.ts` —
    // the same shape as naming, which shells out directly and records its own
    // row in `graduate-session.ts`.
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
      // Creating a pull request is a user action on a session, and ShipIt starts
      // a session's container for user actions — so by the time this runs there
      // is normally a live runner. When there is not, the honest answer is the
      // generic description plus a notice, not booting a container as a side
      // effect of formatting some prose.
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
 * Emit the notice for a **pin** the install can no longer run.
 *
 * Only that case. "Nothing eligible" names no service — nothing failed, ShipIt
 * simply has no opinion — and a notice there would fire on every session of a
 * half-configured install while naming nothing the user can act on. The callers
 * fall back to their pre-feature path instead.
 */
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

/** Run the spawn, record its usage, and turn a failed run into a notice. */
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
  // The credential window, exactly as `runSubAgent` opens it. Non-turn work is
  // chosen independently of the session, so its harness and its account are
  // routinely NOT the session's — which is the whole reason this is not
  // optional: without it an account-backed background model spawns into a
  // container that holds someone else's credentials, or none.
  const credentialsDir = deps.credentialsDir;
  const provisioned = runner instanceof ContainerSessionRunner && !!credentialsDir;
  const accountId = target.route?.kind === "account" ? target.route.id : undefined;
  // Captured once, like `runSubAgent`'s flag: a spawn on the session's OWN
  // harness must not write the session subtree — the primary CLI is routinely
  // LIVE while non-turn work runs (session naming races the first turn), and a
  // provision there swaps the credential file it re-reads mid-turn (the
  // 2026-08-21 401 loop). Such a spawn gets an isolated per-spawn home instead;
  // an unpinned or unknown session keeps the cross-harness path, where there is
  // no live same-subtree reader to collide with.
  const sameHarness = deps.sessionManager?.get(sessionId)?.agentId === target.harnessId;
  try {
    // Inside the try, so the `finally` always closes the borrow it opens
    // (planning#445): a provisioning failure that threw past the cleanup used to
    // leave the subtree lent out for the process's life, and a subtree lent out
    // refuses the session's own token write-backs — the state this fix exists
    // to end. `runSubAgent` opens its window in the same place, for the same
    // reason.
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
        ? { homeDir: subAgentSpawnHomeContainerDir(spawnId) }
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
        // Not `result.costUsd`: that starts at zero and a harness reporting no
        // dollar figure (Codex) is not a harness reporting free.
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
    // Token-sync-back THEN wipe. A same-harness run closes its ISOLATED home
    // (the sync-back to the account/flat root is inside the release) and never
    // touched the session subtree, so there is nothing to restore. A
    // cross-harness run closes the session-subtree borrow: `runSubAgent`'s
    // `finally` in full, for the same reasons — a background generation must
    // not leave a credential behind, and must not leave the session's next
    // turn pointed at someone else's.
    if (provisioned && credentialsDir) {
      if (sameHarness) {
        releaseSubAgentSpawnHome(credentialsDir, sessionId, spawnId);
      } else {
        try {
          if (accountId) syncProviderAccountTokenBack(credentialsDir, sessionId, target.harnessId, accountId);
          else syncAgentTokenBack(credentialsDir, sessionId, target.harnessId);
        } catch {
          // Best-effort: a failed sync-back at worst makes the next provision
          // start from a slightly older token, which heals on its own refresh.
        }
        // docs/260 — which account to put back is the credential subtree's own
        // recorded identity (the marker), not a session row: the row records no
        // route any more. planning#445 — and the borrow itself captured it, at the
        // instant it overwrote the marker: reading it here would find the borrow's
        // own account, and reading it *before* the borrow (what this used to do)
        // could race a concurrent borrow's cleared window and restore nothing,
        // stranding the session with no marker and every rotation refused.
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
