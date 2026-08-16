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
 * nikzlabs/shipit#2350 — both terminal paths also tell the SESSION'S AGENT what the user
 * decided, via a system wake-turn. The consent gate used to swallow its own
 * result: the agent knew a card had been posted and never learned whether it
 * was filed or declined, so it kept describing a filed report as pending. The
 * user still decides; the agent is now told what they decided.
 */

import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import type { WsSubmitBugReport, WsDismissBugReport } from "../../shared/types/ws-client-messages.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { PersistedBugReport } from "../chat-history.js";
import { resolveRunner } from "./resolve-runner.js";
import { persistCardTransition } from "../chat-card-persistence.js";
import {
  fileBugReport,
  buildBugReportFiledWakePrompt,
  buildBugReportDismissedWakePrompt,
  type BugReportProducer,
} from "../services/bug-report.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";

type BugReportCtx = ConnectionCtx &
  RunnerCtx &
  Pick<
    AppCtx,
    | "sessionManager"
    | "githubAuthManager"
    | "chatHistoryManager"
    // nikzlabs/shipit#2350 — the wake-turn half. `wakeSessionWithTurn` owns the stale-runner
    // teardown, container resume and credential refresh, so the outcome lands
    // even when the card is resolved long after the proposing turn ended.
    | "credentialStore"
    | "providerAccountManager"
    | "containerManager"
    | "defaultAgentId"
    | "credentialsDir"
  >;

/**
 * Tell the session's agent how the user resolved a consent card.
 *
 * Deliberately a wake-turn rather than a bare `emitMessage`: an emitted card
 * reaches the browser, not the agent. `dispatch` inside the wake ENQUEUES when
 * a turn is running (so a user who confirms mid-turn doesn't preempt it) and
 * starts one when idle. Best-effort — a failed delivery is logged, never
 * allowed to undo the filing that already happened.
 */
async function notifyAgentOfOutcome(ctx: BugReportCtx, sessionId: string, text: string, activity: string): Promise<void> {
  const session = ctx.sessionManager.get(sessionId);
  if (!session) return;
  const deps: WakeSessionDeps = {
    sessionManager: ctx.sessionManager,
    runnerRegistry: ctx.getRunnerRegistry(),
    defaultAgentId: ctx.defaultAgentId,
    credentialsDir: ctx.credentialsDir,
    credentialStore: ctx.credentialStore,
    providerAccountManager: ctx.providerAccountManager,
    containerManager: ctx.containerManager ?? undefined,
  };
  try {
    await wakeSessionWithTurn(deps, session, { text, activity });
  } catch (err) {
    console.error(`[bug-report] outcome wake-turn not delivered to ${sessionId}:`, err);
  }
}

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
    // nikzlabs/shipit#2350 — close the loop with the agent, carrying the issue number and
    // URL so it can cite the report in a PR body or link it to another one it
    // filed this session.
    await notifyAgentOfOutcome(
      ctx,
      sessionId,
      buildBugReportFiledWakePrompt({ title, number: result.number, url: result.url }),
      "Noting the filed bug report…",
    );
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
 * Look the card up wherever it currently lives. While the proposing turn is
 * still in flight the card sits in `runner.recordedCards` and has not reached a
 * finalized DB row yet, so the history lookup alone would miss it.
 */
function findBugCard(
  ctx: BugReportCtx,
  runner: SessionRunnerInterface,
  sessionId: string,
  cardId: string,
): PersistedBugReport | undefined {
  for (const recorded of runner.recordedCards) {
    if (recorded.message.bugReport?.cardId === cardId) return recorded.message.bugReport;
  }
  return ctx.chatHistoryManager.getBugReportCard(sessionId, cardId);
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
export async function handleDismissBugReport(
  ctx: BugReportCtx,
  msg: WsDismissBugReport,
): Promise<void> {
  const sessionId = ctx.getActiveAppSessionId();
  const runner = resolveRunner(ctx, sessionId);
  if (!sessionId || !runner) {
    ctx.send({ type: "error", message: "No active session for bug report" });
    return;
  }

  const card = findBugCard(ctx, runner, sessionId, msg.cardId);
  // A filed report cannot be un-filed; ignore a stale Cancel rather than
  // rewriting a terminal success into a decline.
  if (card?.phase === "filed" || card?.phase === "dismissed") return;

  runner.emitMessage({ type: "bug_report_dismissed", sessionId, cardId: msg.cardId });
  persistBugCardTransition(ctx, runner, sessionId, msg.cardId, {
    phase: "dismissed",
    errorMessage: undefined,
    scopeError: undefined,
  });

  await notifyAgentOfOutcome(
    ctx,
    sessionId,
    buildBugReportDismissedWakePrompt(card?.title ?? "the bug report"),
    "Noting the declined bug report…",
  );
}
