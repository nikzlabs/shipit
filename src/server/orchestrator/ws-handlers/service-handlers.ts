/**
 * WS handlers for compose service control (start_service, stop_service).
 *
 * These handlers delegate to the ServiceManager for the active session.
 */

import type { WsClientMessage } from "../../shared/types.js";
import type { ConnectionCtx } from "./types.js";
import type { ServiceManager } from "../service-manager.js";

type WsStartService = Extract<WsClientMessage, { type: "start_service" }>;
type WsStopService = Extract<WsClientMessage, { type: "stop_service" }>;
type WsSubscribeServiceLogs = Extract<WsClientMessage, { type: "subscribe_service_logs" }>;

export interface ServiceCtx {
  getServiceManager: () => ServiceManager | null;
}

export async function handleStartService(
  ctx: ConnectionCtx & ServiceCtx,
  msg: WsStartService,
): Promise<void> {
  const mgr = ctx.getServiceManager();
  if (!mgr) {
    ctx.send({ type: "error", message: "No compose stack running for this session" });
    return;
  }
  try {
    await mgr.startService(msg.name);
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to start service "${msg.name}": ${(err as Error).message}` });
  }
}

export function handleSubscribeServiceLogs(
  ctx: ConnectionCtx & ServiceCtx,
  msg: WsSubscribeServiceLogs,
): void {
  const mgr = ctx.getServiceManager();
  if (!mgr) {
    ctx.send({ type: "error", message: "No compose stack running for this session" });
    return;
  }
  const buffer = mgr.getLogBuffer(msg.name);
  ctx.send({ type: "service_log_buffer", name: msg.name, buffer });
}

export async function handleStopService(
  ctx: ConnectionCtx & ServiceCtx,
  msg: WsStopService,
): Promise<void> {
  const mgr = ctx.getServiceManager();
  if (!mgr) {
    ctx.send({ type: "error", message: "No compose stack running for this session" });
    return;
  }
  try {
    await mgr.stopService(msg.name);
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to stop service "${msg.name}": ${(err as Error).message}` });
  }
}
