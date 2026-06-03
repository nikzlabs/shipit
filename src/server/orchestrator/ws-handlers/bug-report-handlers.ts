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
import { resolveRunner } from "./resolve-runner.js";
import { fileBugReport, type BugReportProducer } from "../services/bug-report.js";

type BugReportCtx = ConnectionCtx & RunnerCtx & Pick<AppCtx, "sessionManager" | "githubAuthManager" | "chatHistoryManager">;

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
    // issue link) on reload — the proposing-turn row is finalized by now, so a
    // direct patch is safe. We also persist the user-edited title/body that was
    // actually filed.
    ctx.chatHistoryManager.updateBugReportCard(sessionId, msg.cardId, {
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
  ctx.chatHistoryManager.updateBugReportCard(sessionId, msg.cardId, {
    phase: "draft",
    title,
    body,
    errorMessage: failureMessage,
    scopeError: Boolean(result.scopeError),
  });
}
