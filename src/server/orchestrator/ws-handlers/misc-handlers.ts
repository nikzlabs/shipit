import type { WsClientMessage } from "../../shared/types.js";
import type { AppCtx, ConnectionCtx, RunnerCtx } from "./types.js";
import { resolveRunner } from "./resolve-runner.js";
import { forgetHeldEntries } from "../held-turns.js";
import { interruptAgentTurn } from "../services/agent-interrupt.js";
import type { QueuedMessage } from "../session-runner.js";
import { settleDroppedQueueEntries } from "../turn-settlement.js";
import { takeReturnedMessages } from "../queue-return.js";

type WsCancelQueuedMessage = Extract<WsClientMessage, { type: "cancel_queued_message" }>;
type WsQueueReturnedTaken = Extract<WsClientMessage, { type: "queue_returned_taken" }>;
type WsPrTabActive = Extract<WsClientMessage, { type: "pr_tab_active" }>;

export function handleCancelQueuedMessage(ctx: ConnectionCtx & RunnerCtx, msg: WsCancelQueuedMessage): void {
  const runner = resolveRunner(ctx);
  const queue = runner?.messageQueue ?? [];
  let removed: QueuedMessage[] = [];
  if (msg.position === "all") {
    removed = queue.splice(0, queue.length);
  } else {
    const idx = typeof msg.position === "number" ? msg.position : -1;
    if (idx >= 0 && idx < queue.length) {
      removed = queue.splice(idx, 1);
    }
  }
  // docs/322 — a held turn the user cancels must not come back from its saved row.
  forgetHeldEntries(runner?.answerHoldStore, removed);
  // Its sender waits on this: an automatic CI fix stays "running" for ever without it.
  settleDroppedQueueEntries(removed, "cancelled by the user");
  if (runner) {
    // To every viewer: a second one would otherwise keep showing the cancelled row.
    runner.emitMessage({ type: "queue_updated", sessionId: runner.sessionId, queue: runner.getQueueSnapshot() });
    return;
  }
  const sessionId = ctx.getActiveAppSessionId();
  if (sessionId) ctx.send({ type: "queue_updated", sessionId, queue: [] });
}

/** docs/330-stop-returns-queued-messages — a viewer's input box holds these messages now. */
export function handleQueueReturnedTaken(ctx: ConnectionCtx & RunnerCtx, msg: WsQueueReturnedTaken): void {
  const runner = resolveRunner(ctx);
  if (!runner || !Array.isArray(msg.ids)) return;
  takeReturnedMessages(runner, msg.ids.filter((id): id is string => typeof id === "string"));
}

export function handlePrTabActive(ctx: AppCtx, msg: WsPrTabActive): void {
  if (!msg.sessionId) return;
  ctx.prStatusPoller.setPrTabActive(msg.sessionId, msg.active);
}

export function handleInterruptAgent(ctx: ConnectionCtx & RunnerCtx & AppCtx): void {
  const runner = resolveRunner(ctx);
  // docs/324-scheduled-sessions req 33 — in a scheduled run, this control stops the run too.
  const sessionId = runner?.sessionId ?? ctx.getActiveAppSessionId();
  if (sessionId) ctx.scheduledRuns?.markRunStopped(sessionId);
  const result = interruptAgentTurn({
    sessionManager: ctx.sessionManager,
    broadcastLog: ctx.broadcastLog,
    postInterruptCommitDeps: {
      sessionManager: ctx.sessionManager,
      chatHistoryManager: ctx.chatHistoryManager,
      prStatusPoller: ctx.prStatusPoller,
      githubAuthManager: ctx.githubAuthManager,
      credentialStore: ctx.credentialStore,
      generateText: ctx.generateText,
      createGitManager: ctx.createGitManager,
      scheduleAutoPush: ctx.scheduleAutoPush,
    },
  }, runner);
  if (result === "nothing") ctx.send({ type: "error", message: "No active agent process to interrupt" });
}
