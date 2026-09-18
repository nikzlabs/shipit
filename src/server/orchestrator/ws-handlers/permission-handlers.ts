import type { ConnectionCtx, RunnerCtx } from "./types.js";
import type { WsResolvePermission } from "../../shared/types/ws-client-messages.js";
import { resolveRunner } from "./resolve-runner.js";

type PermissionCtx = ConnectionCtx & RunnerCtx;

export function handleResolvePermission(ctx: PermissionCtx, msg: WsResolvePermission): void {
  const sessionId = ctx.getActiveAppSessionId();
  const runner = resolveRunner(ctx, sessionId);
  if (!sessionId || !runner) {
    ctx.send({ type: "error", message: "No active session for permission request" });
    return;
  }
  if (msg.behavior !== "allow" && msg.behavior !== "deny") {
    ctx.send({ type: "error", message: "Invalid permission decision" });
    return;
  }

  const agent = runner.getAgent();
  // The broker's agent_permission_resolved event updates the card.
  agent?.resolvePermission?.(msg.requestId, {
    behavior: msg.behavior,
    ...(msg.remember ? { remember: true } : {}),
  });
}
