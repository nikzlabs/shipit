import type { WsClientMessage } from "../../shared/types.js";
import type { AppCtx, ConnectionCtx, RunnerCtx } from "./types.js";
import { resolveRunner } from "./resolve-runner.js";
import { scheduleInterruptCommit } from "../services/post-interrupt-commit.js";

type WsCancelQueuedMessage = Extract<WsClientMessage, { type: "cancel_queued_message" }>;
type WsPrTabActive = Extract<WsClientMessage, { type: "pr_tab_active" }>;

export function handleCancelQueuedMessage(ctx: ConnectionCtx & RunnerCtx, msg: WsCancelQueuedMessage): void {
  const runner = resolveRunner(ctx);
  const queue = runner?.messageQueue ?? [];
  if (msg.position === "all") {
    queue.length = 0;
  } else {
    const idx = typeof msg.position === "number" ? msg.position : -1;
    if (idx >= 0 && idx < queue.length) {
      queue.splice(idx, 1);
    }
  }
  ctx.send({
    type: "queue_updated",
    queue: queue.map((item, idx) => ({ text: item.text, position: idx + 1 })),
  });
}

/**
 * docs/133 Phase 4: the PR detail tab became (in)active for a session. Toggle
 * the poller's conversation-field gate. App-wide state only — independent of
 * the WS connection lifecycle, so it reads `msg.sessionId` rather than the
 * connection's attached runner.
 */
export function handlePrTabActive(ctx: AppCtx, msg: WsPrTabActive): void {
  if (!msg.sessionId) return;
  ctx.prStatusPoller.setPrTabActive(msg.sessionId, msg.active);
}

export function handleInterruptAgent(ctx: ConnectionCtx & RunnerCtx & AppCtx): void {
  const runner = resolveRunner(ctx);
  const agent = runner?.getAgent() ?? null;
  if (!agent || !runner) {
    ctx.send({ type: "error", message: "No active agent process to interrupt" });
    return;
  }

  runner.wasInterrupted = true;
  agent.interrupt();
  ctx.broadcastLog("server", "Agent process interrupted by user");
  // Emit via runner so all viewers see the interrupt and reconnects get it
  // from the buffered turn-event log.
  runner.emitMessage({ type: "agent_interrupted" });

  // The normal post-turn commit/PR flow in agent-execution.ts is wired to
  // either the non-streaming `done` handler (process exit) or the streaming
  // `agent_result` handler (turn boundary). Neither is reliable on a
  // streaming-agent interrupt — the CLI doesn't exit, and may not emit
  // `agent_result` for an aborted turn, so the partial work never gets
  // committed. Schedule a deferred commit as a fallback; if `done` or
  // `agent_result` lands first the commit here is a no-op (autoCommit
  // returns null on a clean tree).
  scheduleInterruptCommit({
    deps: {
      sessionManager: ctx.sessionManager,
      chatHistoryManager: ctx.chatHistoryManager,
      prStatusPoller: ctx.prStatusPoller,
      githubAuthManager: ctx.githubAuthManager,
      credentialStore: ctx.credentialStore,
      generateText: ctx.generateText,
      createGitManager: ctx.createGitManager,
      scheduleAutoPush: ctx.scheduleAutoPush,
    },
    runner,
  });
}
