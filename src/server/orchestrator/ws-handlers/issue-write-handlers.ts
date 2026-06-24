/**
 * WS handler for undoing an agent issue write (docs/177).
 *
 * The write itself is do-then-surface: it already happened over the HTTP relay
 * (`shipit issue …` → `/api/sessions/:id/issue/*`), which emitted + persisted
 * the provenance card. This handler fires when the user clicks "Undo" on that
 * card. It is a *reverse brokered write*: recover the tracker + undo snapshot
 * from the persisted card (the server-authoritative source, not client state),
 * perform the reverse write, then patch the card to its terminal undo state.
 *
 * Per the WS-lifecycle contract we resolve the runner via the registry and emit
 * via `runner.emitMessage` so the update lands in the turn-event buffer and
 * survives reconnects; the persisted patch makes it survive a switch/reload.
 */

import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { WsUndoIssueWrite } from "../../shared/types/ws-client-messages.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { IssueWriteCard } from "../../shared/types.js";
import { resolveRunner } from "./resolve-runner.js";
import { persistCardTransition } from "../chat-card-persistence.js";
import { undoIssueWrite } from "../services/issues.js";
import { resolveGitHubTrackerContext } from "../api-routes-issues.js";

type IssueWriteCtx = ConnectionCtx &
  RunnerCtx &
  Pick<AppCtx, "sessionManager" | "githubAuthManager" | "chatHistoryManager" | "credentialStore" | "trackerFetchImpl">;

/**
 * Persist an issue-write card's undo lifecycle (undoing → undone / failed) so it
 * survives a switch/reload, clobber-free if the user clicks Undo while the
 * card's proposing turn is still in flight. Thin wrapper over the shared
 * `persistCardTransition` primitive (see its docstring for the clobber).
 */
function persistIssueWriteTransition(
  ctx: IssueWriteCtx,
  runner: SessionRunnerInterface,
  sessionId: string,
  cardId: string,
  patch: Partial<IssueWriteCard>,
): void {
  persistCardTransition(
    runner,
    { chatHistoryManager: ctx.chatHistoryManager, sessionId },
    (m) => m.issueWrite?.cardId === cardId,
    (m) => ({ ...m, issueWrite: { ...m.issueWrite!, ...patch } }),
    () => ctx.chatHistoryManager.updateIssueWriteCard(sessionId, cardId, patch),
  );
}

export async function handleUndoIssueWrite(
  ctx: IssueWriteCtx,
  msg: WsUndoIssueWrite,
): Promise<void> {
  const sessionId = ctx.getActiveAppSessionId();
  const runner = resolveRunner(ctx, sessionId);
  if (!sessionId || !runner) {
    ctx.send({ type: "error", message: "No active session for issue-write undo" });
    return;
  }

  const card = ctx.chatHistoryManager.findIssueWriteCard(sessionId, msg.cardId);
  if (!card) {
    runner.emitMessage({
      type: "issue_write_update",
      sessionId,
      cardId: msg.cardId,
      undoState: "failed",
      errorMessage: "This write card is no longer available to undo.",
    });
    return;
  }
  // Already undone — idempotent no-op (a double-click or a buffer replay).
  if (card.undoState === "undone") return;

  // Optimistic "undoing" so the button can't be re-clicked mid-flight; persisted
  // so a reload during the reverse write shows the in-flight state.
  runner.emitMessage({ type: "issue_write_update", sessionId, cardId: msg.cardId, undoState: "undoing" });
  persistIssueWriteTransition(ctx, runner, sessionId, msg.cardId, { undoState: "undoing" });

  const github = resolveGitHubTrackerContext(ctx.githubAuthManager, ctx.sessionManager, sessionId);
  try {
    await undoIssueWrite(ctx.credentialStore, card, ctx.trackerFetchImpl, github);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runner.emitMessage({
      type: "issue_write_update",
      sessionId,
      cardId: msg.cardId,
      undoState: "failed",
      errorMessage: message,
    });
    persistIssueWriteTransition(ctx, runner, sessionId, msg.cardId, {
      undoState: "failed",
      errorMessage: message,
    });
    return;
  }

  runner.emitMessage({ type: "issue_write_update", sessionId, cardId: msg.cardId, undoState: "undone" });
  persistIssueWriteTransition(ctx, runner, sessionId, msg.cardId, {
    undoState: "undone",
    errorMessage: undefined,
  });
}
