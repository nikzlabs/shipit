import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { WsSubmitBugReport, WsDismissBugReport } from "../../shared/types/ws-client-messages.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { PersistedBugReport } from "../chat-history.js";
import { resolveRunner } from "./resolve-runner.js";
import { persistCardTransition } from "../chat-card-persistence.js";
import { fileBugReport, type BugReportProducer } from "../services/bug-report.js";

type BugReportCtx = ConnectionCtx & RunnerCtx & Pick<AppCtx, "sessionManager" | "githubAuthManager" | "chatHistoryManager">;

function persistBugCardTransition(
  ctx: BugReportCtx,
  runner: SessionRunnerInterface,
  sessionId: string,
  cardId: string,
  patch: Partial<PersistedBugReport>,
): void {
  persistCardTransition(
    runner,
    { chatHistoryManager: ctx.chatHistoryManager, sessionId },
    (m) => m.bugReport?.cardId === cardId,
    (m) => ({ ...m, bugReport: { ...m.bugReport!, ...patch } }),
    () => ctx.chatHistoryManager.updateBugReportCard(sessionId, cardId, patch),
  );
}

function isTerminal(card: PersistedBugReport | undefined): boolean {
  return card?.phase === "filed" || card?.phase === "dismissed";
}

// Recorded cards can be absent from the DB during a turn and stale after it ends.
function findBugCard(
  ctx: BugReportCtx,
  runner: SessionRunnerInterface,
  sessionId: string,
  cardId: string,
): { card: PersistedBugReport | undefined; terminal: boolean } {
  let recorded: PersistedBugReport | undefined;
  for (const entry of runner.recordedCards) {
    if (entry.message.bugReport?.cardId === cardId) {
      recorded = entry.message.bugReport;
      break;
    }
  }
  const stored = ctx.chatHistoryManager.getBugReportCard(sessionId, cardId);
  const card = runner.running ? (recorded ?? stored) : (stored ?? recorded);
  return { card, terminal: isTerminal(recorded) || isTerminal(stored) };
}

// Claimed before the GitHub call, so two submits of one card cannot file two issues.
const filingInFlight = new Set<string>();

// A filed or dismissed card answers a submit with its saved state.
function answerSettled(ctx: BugReportCtx, runner: SessionRunnerInterface, sessionId: string, cardId: string): boolean {
  const { card, terminal } = findBugCard(ctx, runner, sessionId, cardId);
  if (!terminal) return false;
  if (card?.phase === "filed" && card.issueUrl && typeof card.issueNumber === "number") {
    runner.emitMessage({ type: "bug_report_filed", sessionId, cardId, number: card.issueNumber, url: card.issueUrl });
  } else {
    runner.emitMessage({ type: "bug_report_dismissed", sessionId, cardId });
  }
  return true;
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

  // Before validation: a stale form's empty submit must not send "failed" for a saved filed card.
  if (answerSettled(ctx, runner, sessionId, msg.cardId)) return;

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

  // By session too: a fork copies the card with its id.
  const claim = `${sessionId}:${msg.cardId}`;
  if (filingInFlight.has(claim)) return;
  const session = ctx.sessionManager.get(sessionId);
  const producer: BugReportProducer = session?.kind === "ops" ? "ops" : "session";

  filingInFlight.add(claim);
  let result: Awaited<ReturnType<typeof fileBugReport>>;
  try {
    result = await fileBugReport(ctx.githubAuthManager, { title, body, producer });
  } finally {
    filingInFlight.delete(claim);
  }

  if (result.success && result.url && typeof result.number === "number") {
    runner.emitMessage({
      type: "bug_report_filed",
      sessionId,
      cardId: msg.cardId,
      number: result.number,
      url: result.url,
    });
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

  // A dismissal can land while the filing waits; its failure must not reopen the card.
  if (answerSettled(ctx, runner, sessionId, msg.cardId)) return;

  const failureMessage = result.message ?? "Failed to file the bug report.";
  runner.emitMessage({
    type: "bug_report_failed",
    sessionId,
    cardId: msg.cardId,
    message: failureMessage,
    ...(result.scopeError ? { scopeError: true } : {}),
  });
  persistBugCardTransition(ctx, runner, sessionId, msg.cardId, {
    phase: "draft",
    title,
    body,
    errorMessage: failureMessage,
    scopeError: Boolean(result.scopeError),
  });
}

export function handleDismissBugReport(
  ctx: BugReportCtx,
  msg: WsDismissBugReport,
): void {
  const sessionId = ctx.getActiveAppSessionId();
  const runner = resolveRunner(ctx, sessionId);
  if (!sessionId || !runner) {
    ctx.send({ type: "error", message: "No active session for bug report" });
    return;
  }

  const { card, terminal } = findBugCard(ctx, runner, sessionId, msg.cardId);
  if (terminal) return;
  if (!card) {
    ctx.send({ type: "error", message: "Unknown bug report card" });
    return;
  }

  runner.emitMessage({ type: "bug_report_dismissed", sessionId, cardId: msg.cardId });
  persistBugCardTransition(ctx, runner, sessionId, msg.cardId, {
    phase: "dismissed",
    errorMessage: undefined,
    scopeError: undefined,
  });
}
