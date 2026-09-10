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
  if (card.undoState === "undone") return;

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
