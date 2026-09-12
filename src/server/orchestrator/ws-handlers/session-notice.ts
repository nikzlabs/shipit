import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { resolveRunner } from "./resolve-runner.js";
import { emitNoticeInTurn, emitNoticePostTurn } from "../chat-card-persistence.js";

/** Persisted: a refused or intercepted command has no bubble, so the notice is its only trace. */
export function emitSessionNotice(
  ctx: ConnectionCtx & RunnerCtx & AppCtx,
  sessionId: string,
  message: string,
  level: "info" | "warn" = "info",
): void {
  const runner = resolveRunner(ctx);
  if (runner) emitNoticeInTurn(runner, sessionId, message, ctx.chatHistoryManager, level);
  else emitNoticePostTurn((m) => { ctx.send(m); }, ctx.chatHistoryManager, sessionId, message, level);
}
