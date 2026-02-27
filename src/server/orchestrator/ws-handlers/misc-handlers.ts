import type { WsClientMessage } from "../../shared/types.js";
import type { HandlerContext } from "./types.js";

type WsCancelQueuedMessage = Extract<WsClientMessage, { type: "cancel_queued_message" }>;

export function handleCancelQueuedMessage(ctx: HandlerContext, msg: WsCancelQueuedMessage): void {
  const queue = ctx.getMessageQueue();
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

export function handleInterruptClaude(ctx: HandlerContext): void {
  const agent = ctx.getAgent();
  if (agent) {
    ctx.setWasInterrupted(true);
    agent.interrupt();
    ctx.broadcastLog("server", "Claude process interrupted by user");
    // Emit via runner so all viewers see the interrupt
    const runner = ctx.getRunner();
    if (runner) {
      runner.emitMessage({ type: "claude_interrupted" });
    } else {
      ctx.send({ type: "claude_interrupted" });
    }
  } else {
    ctx.send({ type: "error", message: "No active Claude process to interrupt" });
  }
}
