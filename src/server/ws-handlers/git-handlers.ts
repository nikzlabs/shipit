import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";

type WsRollback = Extract<WsClientMessage, { type: "rollback" }>;

export async function handleRollback(ctx: HandlerContext, msg: WsRollback): Promise<void> {
  try {
    const git = ctx.getActiveGitManager();
    await git.rollback(msg.commitHash);
    ctx.send({ type: "rollback_complete", commitHash: msg.commitHash });

    // Restart Vite after rollback since files changed
    ctx.previewManager.restart(ctx.getActiveDir());
  } catch (err) {
    ctx.send({ type: "error", message: `Rollback failed: ${getErrorMessage(err)}` });
  }
}
