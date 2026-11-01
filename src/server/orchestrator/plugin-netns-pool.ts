import crypto from "node:crypto";
import type Docker from "dockerode";
import {
  buildPluginNetns,
  PLUGIN_NETNS_LABEL,
  PLUGIN_NETNS_PARENT_LABEL,
  resolvePluginNetnsPlan,
  withDeadline,
  type BuiltPluginNetns,
  type PreparePluginNetnsOptions,
} from "./plugin-egress.js";

// Building a namespace is most of what a plugin command costs to start
// (docs/262-plugins plan.md, "What a call costs to start"). The lifetime runs
// from the build, not from the last use: it also bounds how old the addresses
// a namespace resolved for an allowed name can be.
export const PLUGIN_NETNS_LIFETIME_MS = 10 * 60_000;
export const MAX_IDLE_PLUGIN_NETNS_PER_SESSION = 4;
const LIVENESS_TIMEOUT_MS = 5_000;

export interface PluginNetnsLease {
  networkMode: string;
  /** True when this call did not build the namespace. */
  reused: boolean;
  /** `reusable` only when nothing the call started can still be in the namespace. */
  release(opts: { reusable: boolean }): Promise<void>;
}

interface IdleNetns {
  fingerprint: string;
  netns: BuiltPluginNetns;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const idle = new Map<string, IdleNetns[]>();

/**
 * A namespace for one plugin command. One lease is one command: a namespace is
 * never shared by two running commands, only handed to the next one, and only
 * while the session's policy would build a namespace from the same plan.
 */
export async function acquirePluginNetns(
  opts: PreparePluginNetnsOptions & { lifetimeMs?: number },
): Promise<PluginNetnsLease> {
  const plan = await resolvePluginNetnsPlan(opts);
  if (!plan) {
    return { networkMode: opts.network, reused: false, release: async () => undefined };
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");

  let kept: IdleNetns | null = null;
  for (let taken = takeIdle(opts.sessionId, fingerprint); taken; taken = takeIdle(opts.sessionId, fingerprint)) {
    if (await isIntact(opts.docker, opts.sessionId, taken.netns)) {
      kept = taken;
      break;
    }
    void taken.netns.release();
  }
  const netns = kept?.netns ?? await buildPluginNetns(opts, plan);
  const expiresAt = kept?.expiresAt ?? Date.now() + (opts.lifetimeMs ?? PLUGIN_NETNS_LIFETIME_MS);

  return {
    networkMode: netns.networkMode,
    reused: kept !== null,
    release: async ({ reusable }) => {
      const entries = idle.get(opts.sessionId) ?? [];
      const remainingMs = expiresAt - Date.now();
      if (!reusable || remainingMs <= 0 || entries.length >= MAX_IDLE_PLUGIN_NETNS_PER_SESSION) {
        await netns.release();
        return;
      }
      const entry: IdleNetns = {
        fingerprint,
        netns,
        expiresAt,
        timer: setTimeout(() => expire(opts.sessionId, entry), remainingMs),
      };
      entry.timer.unref?.();
      idle.set(opts.sessionId, [...entries, entry]);
    },
  };
}

// Synchronous, so two concurrent calls can never take the same namespace.
function takeIdle(sessionId: string, fingerprint: string): IdleNetns | null {
  const entries = idle.get(sessionId) ?? [];
  const current = entries.filter((e) => e.fingerprint === fingerprint);
  // The policy changed: what the others allow is no longer what the session allows.
  for (const stale of entries.filter((e) => e.fingerprint !== fingerprint)) discard(stale);
  const taken = current.pop();
  if (current.length > 0) idle.set(sessionId, current);
  else idle.delete(sessionId);
  if (!taken) return null;
  clearTimeout(taken.timer);
  return taken;
}

// A dead resolver or proxy fails closed, so reusing its namespace would fail every later call.
async function isIntact(
  docker: Docker,
  sessionId: string,
  netns: BuiltPluginNetns,
): Promise<boolean> {
  try {
    const running = await withDeadline(LIVENESS_TIMEOUT_MS, () => docker.listContainers({
      filters: { label: [`${PLUGIN_NETNS_LABEL}=${sessionId}`], status: ["running"] },
    }));
    const sidecars = running.filter((c) => c.Labels?.[PLUGIN_NETNS_PARENT_LABEL] === netns.holderId);
    return running.some((c) => c.Id === netns.holderId) && sidecars.length === netns.sidecars;
  } catch {
    return false;
  }
}

function expire(sessionId: string, entry: IdleNetns): void {
  const remaining = (idle.get(sessionId) ?? []).filter((e) => e !== entry);
  if (remaining.length > 0) idle.set(sessionId, remaining);
  else idle.delete(sessionId);
  void entry.netns.release();
}

function discard(entry: IdleNetns): void {
  clearTimeout(entry.timer);
  void entry.netns.release();
}

/**
 * The session's container is gone, so no command will ask for these soon. A
 * namespace a running command still holds is not here; it expires on its own.
 */
export function dropIdlePluginNetns(sessionId: string): void {
  const entries = idle.get(sessionId) ?? [];
  idle.delete(sessionId);
  for (const entry of entries) discard(entry);
}

export function idlePluginNetnsCount(sessionId: string): number {
  return idle.get(sessionId)?.length ?? 0;
}

export function _resetPluginNetnsPool(): void {
  for (const entries of idle.values()) {
    for (const entry of entries) clearTimeout(entry.timer);
  }
  idle.clear();
}
