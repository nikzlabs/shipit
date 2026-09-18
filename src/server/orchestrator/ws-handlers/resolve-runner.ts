import type { RunnerCtx, ConnectionCtx } from "./types.js";
import type { SessionRunnerInterface } from "../session-runner.js";

// Pass a captured sessionId in async callbacks; connection state can change or disconnect.
export function resolveRunner(
  ctx: ConnectionCtx & RunnerCtx,
  sessionId?: string,
): SessionRunnerInterface | null {
  const sid = sessionId ?? ctx.getActiveAppSessionId();
  if (sid) {
    const r = ctx.getRunnerRegistry().get(sid);
    if (r) return r;
  }
  return ctx.getRunner();
}
