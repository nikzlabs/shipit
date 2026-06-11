/**
 * WS handler for resolving a sensitive-action permission request
 * (docs/193 / SHI-112).
 *
 * The *request* card arrives off the agent-event stream (the worker's
 * `PermissionBroker` broadcasts `agent_permission_request`, persisted via
 * `emitChatCard` in agent-listeners). This handler fires when the user clicks
 * Approve / Deny on that card: it forwards the decision to the in-container
 * broker via `agent.resolvePermission` (ProxyAgentProcess → worker
 * `/agent/permission/resolve`), which unblocks the held bridge/RPC call. The
 * terminal card state is NOT patched here — the broker's resulting
 * `agent_permission_resolved` broadcast drives the patch in agent-listeners,
 * keeping the live and persisted card in sync from one place.
 *
 * Per the WS-lifecycle contract, the runner is resolved via the registry so a
 * reconnect mid-prompt doesn't lose the resolution path.
 */

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
  // Optional method: present on the container-mode ProxyAgentProcess. In
  // local/test mode (no worker, no broker) it's absent and this is a no-op —
  // the request there already failed closed (deny), so there's nothing to
  // unblock.
  agent?.resolvePermission?.(msg.requestId, {
    behavior: msg.behavior,
    ...(msg.remember ? { remember: true } : {}),
  });
}
