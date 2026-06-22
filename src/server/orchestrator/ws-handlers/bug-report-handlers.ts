/**
 * WS handlers for user bug filing (docs/164).
 *
 * Only the *confirm* step lives here. The *draft* arrives over HTTP (the
 * agent's `report_shipit_bug` tool → worker → `/api/sessions/:id/bug-report`),
 * which redacts it and emits the consent card. This handler fires when the
 * user clicks "Submit report" on that card: it files the (possibly user-
 * edited) issue on the fixed upstream repo under the user's own GitHub
 * identity, then updates the card in place to a filed/failed terminal state.
 *
 * Per the WS-lifecycle contract, we resolve the runner via the registry and
 * emit via `runner.emitMessage` so the result lands in the turn-event buffer
 * and survives reconnects.
 */

import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { WsSubmitBugReport } from "../../shared/types/ws-client-messages.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { PersistedBugReport } from "../chat-history.js";
import { resolveRunner } from "./resolve-runner.js";
import { updateRecordedCard, persistTurnInProgress } from "../chat-card-persistence.js";
import { fileBugReport, type BugReportProducer } from "../services/bug-report.js";

type BugReportCtx = ConnectionCtx & RunnerCtx & Pick<AppCtx, "sessionManager" | "githubAuthManager" | "chatHistoryManager">;

/**
 * Persist a bug-report card's terminal (filed/failed) transition so it survives
 * a session switch / full reload.
 *
 * The card is recorded on the runner at draft time (`emitChatCard` →
 * `recordedCards`), and `recordedCards` is cleared only at the *next* turn start
 * — never at turn end. So if the user confirms the card while the proposing turn
 * is still in flight (the agent filed a bug then kept working), a DB-only
 * `updateBugReportCard` patch is clobbered when that turn finalizes and rebuilds
 * its in-progress rows from `recordedCards`, which still hold the draft snapshot
 * — the card reverts to its full draft form on the next switch/reload.
 *
 * Mirror the permission-card resolution path (docs/193): while the turn is
 * running, patch the recorded card in place so every rebuild (and the final
 * end-of-turn persist) carries the terminal state, then flush. Once the turn has
 * finalized, `running` is false and the stale `recordedCards` are inert, so the
 * direct DB-row patch is safe — and remains the default, since a bug card is
 * usually confirmed after its proposing turn ends.
 */
function persistBugCardTransition(
  ctx: BugReportCtx,
  runner: SessionRunnerInterface,
  sessionId: string,
  cardId: string,
  patch: Partial<PersistedBugReport>,
): void {
  const patchedInFlight =
    runner.running &&
    updateRecordedCard(
      runner,
      (m) => m.bugReport?.cardId === cardId,
      (m) => ({ ...m, bugReport: { ...m.bugReport!, ...patch } }),
    );
  if (patchedInFlight) {
    persistTurnInProgress(ctx.chatHistoryManager, runner, sessionId);
  } else {
    ctx.chatHistoryManager.updateBugReportCard(sessionId, cardId, patch);
  }
}

export async function handleSubmitBugReport(
  ctx: BugReportCtx,
  msg: WsSubmitBugReport,
): Promise<void> {
  const sessionId = ctx.getActiveAppSessionId();
  const runner = resolveRunner(ctx, sessionId);
  if (!sessionId || !runner) {
    ctx.send({ type: "error", message: "No active session for bug report" });
    return;
  }

  const title = typeof msg.title === "string" ? msg.title.trim() : "";
  const body = typeof msg.body === "string" ? msg.body : "";
  if (!title || !body.trim()) {
    runner.emitMessage({
      type: "bug_report_failed",
      sessionId,
      cardId: msg.cardId,
      message: "Title and body are required to file the report.",
    });
    return;
  }

  // The producer is re-derived from the session (server-authoritative), not
  // trusted from the client — it only drives the label markers.
  const session = ctx.sessionManager.get(sessionId);
  const producer: BugReportProducer = session?.kind === "ops" ? "ops" : "session";

  const result = await fileBugReport(ctx.githubAuthManager, { title, body, producer });

  if (result.success && result.url && typeof result.number === "number") {
    runner.emitMessage({
      type: "bug_report_filed",
      sessionId,
      cardId: msg.cardId,
      number: result.number,
      url: result.url,
    });
    // Persist the terminal state so the card comes back as "filed" (with its
    // issue link) on reload. We also persist the user-edited title/body that
    // was actually filed. `persistBugCardTransition` keeps the patch from being
    // clobbered if the proposing turn is still in flight when the user confirms.
    persistBugCardTransition(ctx, runner, sessionId, msg.cardId, {
      phase: "filed",
      title,
      body,
      issueNumber: result.number,
      issueUrl: result.url,
      errorMessage: undefined,
      scopeError: undefined,
    });
    return;
  }

  const failureMessage = result.message ?? "Failed to file the bug report.";
  runner.emitMessage({
    type: "bug_report_failed",
    sessionId,
    cardId: msg.cardId,
    message: failureMessage,
    ...(result.scopeError ? { scopeError: true } : {}),
  });
  // Persist the failure as an editable draft (mirrors the client `setFailed`
  // → draft behavior) so a reload brings the card back ready for retry rather
  // than losing the error context entirely.
  persistBugCardTransition(ctx, runner, sessionId, msg.cardId, {
    phase: "draft",
    title,
    body,
    errorMessage: failureMessage,
    scopeError: Boolean(result.scopeError),
  });
}
