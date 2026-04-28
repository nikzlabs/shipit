/**
 * Runner resolution helper for WebSocket handlers.
 *
 * Why this exists: state mutations and reads must NOT depend on the per-
 * connection `attachedRunner`, which becomes null after WS disconnect. The
 * registry, by contrast, holds the runner for the entire session lifetime
 * and survives any number of WS reconnects. See feature 095 plan.
 *
 * Use this at the top of every handler that needs to touch runner state:
 *
 *   const runner = resolveRunner(ctx);
 *   if (!runner) { ... appropriate error / no-op ... }
 *   runner.running = true;        // direct mutation, not via ctx setter
 *   runner.emitMessage({ ... });  // broadcast to all viewers + buffer
 */

import type { RunnerCtx, ConnectionCtx } from "./types.js";
import type { SessionRunnerInterface } from "../session-runner.js";

/**
 * Resolve the SessionRunner for the current handler. Prefers a registry
 * lookup by the captured session ID — that survives WS disconnects — and
 * falls back to the per-connection attached runner.
 *
 * Pass `sessionId` explicitly when you have one captured at function entry;
 * otherwise this reads it from `ctx`, which is fine for synchronous handler
 * code but UNSAFE inside async closures (the active session can change).
 */
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
