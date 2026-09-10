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
  runner.emitMessage({ type: "agent_interrupted" });

  // Interrupted streaming turns may emit neither done nor agent_result.
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
