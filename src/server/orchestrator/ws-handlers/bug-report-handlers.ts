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
 *
 * nikzlabs/shipit#2350 — both terminal paths also record the outcome durably on the
 * card, so the agent can be told what the user decided. The consent gate used to
 * swallow its own result: the agent knew a card had been posted and never
 * learned whether it was filed or declined, so it kept describing a filed report
 * as pending. The user still decides; the agent is now told what they decided.
 *
 * Delivery deliberately does NOT happen here. Nothing wakes the session — the
 * outcome rides as a prefix on the user's next turn
 * (`consumeUnreportedBugOutcomes` in `agent-execution.ts`). Filing a bug is a
 * side errand, and interrupting the user and the agent to announce what the
 * card on screen already says would be the distraction, not the fix.
 */

import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { WsSubmitBugReport, WsDismissBugReport } from "../../shared/types/ws-client-messages.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { PersistedBugReport } from "../chat-history.js";
import { resolveRunner } from "./resolve-runner.js";
import { persistCardTransition } from "../chat-card-persistence.js";
import { fileBugReport, type BugReportProducer } from "../services/bug-report.js";

type BugReportCtx = ConnectionCtx & RunnerCtx & Pick<AppCtx, "sessionManager" | "githubAuthManager" | "chatHistoryManager">;

/**
 * Persist a bug-report card's terminal (filed/failed) transition so it survives
 * a session switch / full reload, clobber-free if the user confirms the card
 * while its proposing turn is still in flight. Thin wrapper over the shared
 * `persistCardTransition` primitive (see its docstring for the clobber and why
 * the running-gated recorded-card patch fixes it).
 */
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

/** A phase no later click may overwrite. */
function isTerminal(card: PersistedBugReport | undefined): boolean {
  return card?.phase === "filed" || card?.phase === "dismissed";
}

/**
 * Look the card up in BOTH places it can live, because neither alone is
 * trustworthy on its own.
 *
 * While the proposing turn is in flight the card sits in `runner.recordedCards`
 * and has no finalized DB row, so the history lookup misses it. But
 * `recordedCards` is cleared only at the NEXT turn start — never at turn end —
 * so once that turn finalizes, the snapshot is *inert and stale*:
 * `persistCardTransition` deliberately patches only the DB row from then on.
 * Reading the recorded set first would therefore see a `draft` for a card the
 * DB already records as `filed`, and a late Cancel would overwrite a real
 * success with a decline (dropping the issue URL) and tell the agent a filed
 * report was declined.
 *
 * So: `running` picks which source is authoritative — the same discriminator
 * `persistCardTransition` uses to decide where to write — and `terminal` is
 * true if EITHER source says so, which keeps the guard correct even if that
 * discriminator is ever wrong.
 */
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

  // Terminal states are terminal in BOTH directions, and this guard is what
  // makes filing idempotent. Without it a card the user DECLINED could still be
  // filed by a second tab that never saw the dismissal (the report goes public
  // against their wishes, and the agent has already been told it never would),
  // and a double-click or a second tab could file the SAME report twice, with
  // the card keeping only the last issue number. The optimistic `filing` phase
  // does not close this: it is per-tab store state and is never broadcast.
  const existing = findBugCard(ctx, runner, sessionId, msg.cardId);
  if (existing.terminal) {
    const card = existing.card;
    if (card?.phase === "filed" && card.issueUrl && typeof card.issueNumber === "number") {
      // Re-assert the state this stale client is missing rather than refiling.
      runner.emitMessage({
        type: "bug_report_filed",
        sessionId,
        cardId: msg.cardId,
        number: card.issueNumber,
        url: card.issueUrl,
      });
    } else {
      runner.emitMessage({ type: "bug_report_dismissed", sessionId, cardId: msg.cardId });
    }
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
  // No wake on failure: nothing was filed, so the report is still pending —
  // exactly the state the agent already believes it is in. The card carries the
  // error for the user, who can fix their token and resubmit.
}

/**
 * nikzlabs/shipit#2350 — the user clicked "Cancel" on a consent card.
 *
 * Cancel used to be local component state: nothing was persisted, so a reload
 * brought the declined card back as an editable draft, and the agent went on
 * believing the report was still awaiting the user — which made it both
 * inaccurate and needlessly reluctant to propose an unrelated report. The click
 * now persists a terminal `dismissed` phase, echoes to every attached viewer,
 * and tells the agent the report was declined.
 */
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
  // A filed report cannot be un-filed, and a second Cancel has nothing to do;
  // ignore a stale click rather than rewriting a terminal state and re-waking
  // the agent.
  if (terminal) return;
  // An unknown card id names nothing to decline. Refuse rather than collapsing
  // a card nobody has and waking the agent about "the bug report".
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
