import type { WsClientMessage, WsLogRecord, LogSource } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx } from "./types.js";
import type { ServiceManager } from "../service-manager.js";
import type { LogStore } from "../log-store.js";
import { resolveRunner } from "./resolve-runner.js";

type WsStartService = Extract<WsClientMessage, { type: "start_service" }>;
type WsStopService = Extract<WsClientMessage, { type: "stop_service" }>;
type WsSubscribeLogs = Extract<WsClientMessage, { type: "subscribe_logs" }>;
type WsLogClear = Extract<WsClientMessage, { type: "log_clear" }>;

export interface ServiceCtx {
  getServiceManager: () => ServiceManager | null;
  logStore?: LogStore;
}

const SERVICE_PREFIX = "service:";

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

export async function handleSubscribeLogs(
  ctx: ConnectionCtx & ServiceCtx,
  msg: WsSubscribeLogs,
): Promise<void> {
  const { channel } = msg;

  if (channel === "agent") {
    const sessionId = ctx.getActiveAppSessionId();
    const records: WsLogRecord[] = sessionId && ctx.logStore
      ? ctx.logStore.snapshotEntries(sessionId, "agent").map((e) => ({
          ts: e.ts,
          source: (e.source || undefined) as LogSource | undefined,
          text: e.text,
        }))
      : [];
    ctx.send({ type: "log_snapshot", channel, records });
    return;
  }

  if (channel.startsWith(SERVICE_PREFIX)) {
    const name = channel.slice(SERVICE_PREFIX.length);
    const mgr = ctx.getServiceManager();
    if (!mgr) {
      ctx.send({ type: "log_snapshot", channel, records: [] });
      return;
    }
    const buffer = await mgr.snapshotLogs(name);
    ctx.send({ type: "log_snapshot", channel, records: buffer ? [{ ts: "", text: buffer }] : [] });
    return;
  }

  ctx.send({ type: "log_snapshot", channel, records: [] });
}

export function handleLogClear(
  ctx: ConnectionCtx & RunnerCtx & ServiceCtx,
  msg: WsLogClear,
): void {
  const { channel } = msg;
  if (channel === "agent") {
    ctx.clearLogBuffer();
    resolveRunner(ctx)?.clearTerminalOutputBuffer();
    return;
  }
  if (channel.startsWith(SERVICE_PREFIX)) {
    const sessionId = ctx.getActiveAppSessionId();
    if (sessionId && ctx.logStore) ctx.logStore.clear(sessionId, channel);
  }
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
