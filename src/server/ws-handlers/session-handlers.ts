import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";

type WsActivateSession = Extract<WsClientMessage, { type: "activate_session" }>;

/**
 * Activate a session — attaches the runner, file watcher, preview, etc.
 * This is the WS-only side effect of session switching. The client calls
 * GET /api/sessions/:id/history for data first, then sends this message
 * to wire up the live connection to the session.
 */
export async function handleActivateSession(ctx: HandlerContext, msg: WsActivateSession): Promise<void> {
  const session = ctx.sessionManager.get(msg.sessionId);

  // Check if a worktree session's directory is missing before activating
  if (session?.sessionType === "worktree" && session.workspaceDir) {
    const fsModule = await import("node:fs/promises");
    const dirExists = await fsModule.stat(session.workspaceDir).then(() => true, () => false);
    if (!dirExists) {
      ctx.send({
        type: "error",
        message: "This session's workspace is no longer available. The worktree may have been cleaned up.",
      });
      return;
    }
  }

  // Activate the requested session (attach runner, file watcher, preview, port scan, etc.)
  await ctx.activateSession(msg.sessionId);
}

export function handleNewSession(ctx: HandlerContext): void {
  // Detach from current runner (it keeps running in the background)
  ctx.detachFromRunner();
  // Clear active session — next send_message or apply_template will create a new one
  ctx.setActiveAppSessionId(undefined);
  ctx.setActiveSessionDir(null);
  ctx.send({ type: "session_list", sessions: ctx.sessionManager.list() });
}
