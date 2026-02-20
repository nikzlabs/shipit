import path from "node:path";
import fs from "node:fs/promises";
import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";

type WsPreviewError = Extract<WsClientMessage, { type: "preview_error" }>;
type WsCancelQueuedMessage = Extract<WsClientMessage, { type: "cancel_queued_message" }>;

export function handlePreviewError(ctx: HandlerContext, msg: WsPreviewError): void {
  // Validate the preview error message
  const errorMsg = typeof msg.message === "string" ? msg.message : "";
  if (!errorMsg.trim()) {
    ctx.send({ type: "error", message: "Preview error message cannot be empty" });
    return;
  }
  if (errorMsg.length > 10_000) {
    ctx.send({ type: "error", message: "Preview error message too long (max 10,000 characters)" });
    return;
  }
  // Format the error for the terminal log buffer
  const parts = [errorMsg];
  if (msg.stack && typeof msg.stack === "string") {
    parts.push(msg.stack.slice(0, 5000));
  }
  ctx.broadcastLog("preview", parts.join("\n"));
}

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

export async function handleFullReset(ctx: HandlerContext): Promise<void> {
  try {
    // 1. Dispose all runners (kills all agent processes + queues)
    ctx.getRunnerRegistry().disposeAll();
    ctx.detachFromRunner();
    ctx.previewManager.stop();
    ctx.fileWatcher.stop();
    const terminal = ctx.getTerminal();
    if (terminal) {
      terminal.kill();
      ctx.setTerminal(null);
    }

    // 2. Delete all persistent data
    const deletePaths = [
      path.join(ctx.workspaceDir, "sessions"),
      path.join(ctx.workspaceDir, ".vibe-chat-history"),
      path.join(ctx.workspaceDir, ".vibe-threads"),
      path.join(ctx.workspaceDir, ".shipit-usage.json"),
      path.join(ctx.workspaceDir, ".shipit"),
      path.join(ctx.workspaceDir, ".github-token"),
      path.join(ctx.workspaceDir, ".shipit-deploy"),
      path.join(ctx.workspaceDir, ".vibe-sessions.json"),
    ];

    for (const p of deletePaths) {
      try {
        await fs.rm(p, { recursive: true, force: true });
      } catch {
        // Best-effort — ignore individual failures
      }
    }

    // 3. Clear in-memory state so managers don't serve stale data
    ctx.sessionManager.clear();
    ctx.usageManager.clear();

    // 4. Reset connection state
    ctx.setActiveAppSessionId(undefined);
    ctx.setActiveSessionDir(null);

    // Broadcast to all connected clients so all tabs see the reset
    ctx.broadcast({ type: "full_reset_complete" });
  } catch (err) {
    ctx.send({ type: "error", message: `Full reset failed: ${getErrorMessage(err)}` });
  }
}
