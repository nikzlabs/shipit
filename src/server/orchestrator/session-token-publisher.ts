// Watch for the CLI's lifetime: resident processes can rotate tokens between turns.
// Stat polling sees atomic renames from another container without relying on inotify.
import fs from "node:fs";
import type { AgentId } from "../shared/types/agent-types.js";
import {
  agentTokenFilePaths,
  sessionTokenIsAheadOfSource,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
} from "./token-sync-manager.js";
import { getErrorMessage } from "./validation.js";

export const TOKEN_WATCH_POLL_INTERVAL_MS = 3_000;
export const TOKEN_PUBLISH_DEBOUNCE_MS = 750;

interface TokenWatch {
  routeKey: string;
  paths: string[];
  listener: (curr: fs.Stats, prev: fs.Stats) => void;
  debounce: NodeJS.Timeout | null;
  runner: TokenWatchRunner | undefined;
  detachRunner: () => void;
}

const watches = new Map<string, TokenWatch>();

export interface TokenWatchRunner {
  on(event: "disposed", listener: () => void): unknown;
  off(event: "disposed", listener: () => void): unknown;
}

export interface StartTokenWriteBackWatchOptions {
  credentialsDir: string;
  sessionId: string;
  agentId: AgentId;
  /** Skip claude-env-oauth routes: they have no source token file. */
  accountId?: string;
  runner?: TokenWatchRunner;
  pollIntervalMs?: number;
  debounceMs?: number;
}

export function startTokenWriteBackWatch(opts: StartTokenWriteBackWatchOptions): void {
  const { credentialsDir, sessionId, agentId, accountId } = opts;
  const routeKey = `${agentId}:${accountId ?? ""}`;
  const existing = watches.get(sessionId);
  if (existing) {
    // Rebind disposal after a container rebuild, even when its route is unchanged.
    if (existing.routeKey === routeKey && existing.runner === opts.runner) return;
    stopTokenWriteBackWatch(sessionId);
  }

  let paths: string[];
  try {
    paths = agentTokenFilePaths(credentialsDir, sessionId, agentId);
  } catch (err) {
    console.warn(`[token-publish] could not resolve token files for ${sessionId}:`, getErrorMessage(err));
    return;
  }
  if (paths.length === 0) return;

  const debounceMs = opts.debounceMs ?? TOKEN_PUBLISH_DEBOUNCE_MS;
  const interval = opts.pollIntervalMs ?? TOKEN_WATCH_POLL_INTERVAL_MS;

  const watch: TokenWatch = {
    routeKey,
    paths,
    listener: () => {},
    debounce: null,
    runner: opts.runner,
    detachRunner: () => {},
  };

  const publish = (): void => {
    watch.debounce = null;
    if (watches.get(sessionId) !== watch) return;
    try {
      // Ignore unrelated rewrites before sync-back's credential-tree chown.
      if (!sessionTokenIsAheadOfSource(credentialsDir, sessionId, agentId, accountId)) return;
      if (accountId) {
        // The pre-spawn route owns this watch; an active borrow still blocks write-back.
        syncProviderAccountTokenBack(credentialsDir, sessionId, agentId, accountId, { sessionOwnRoute: true });
      } else {
        syncAgentTokenBack(credentialsDir, sessionId, agentId, { sessionOwnRoute: true });
      }
      console.log(
        `[token-publish] published mid-turn ${agentId} token rotation from ${sessionId}${accountId ? ` (account ${accountId})` : ""}`,
      );
    } catch (err) {
      console.warn(`[token-publish] mid-turn sync-back failed for ${sessionId}:`, getErrorMessage(err));
    }
  };

  const schedule = (): void => {
    if (watch.debounce) clearTimeout(watch.debounce);
    watch.debounce = setTimeout(publish, debounceMs);
    watch.debounce.unref?.();
  };

  watch.listener = (curr: fs.Stats, prev: fs.Stats): void => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) return;
    schedule();
  };

  for (const file of paths) {
    fs.watchFile(file, { interval, persistent: false }, watch.listener);
  }

  if (opts.runner) {
    const runner = opts.runner;
    const onDisposed = (): void => stopTokenWriteBackWatch(sessionId);
    runner.on("disposed", onDisposed);
    watch.detachRunner = () => runner.off("disposed", onDisposed);
  }

  watches.set(sessionId, watch);
  // Catch rotations before watchFile's asynchronous baseline, including stranded writes.
  schedule();
}

// Do not stop at turn end while a resident CLI can still rotate tokens.
export function stopTokenWriteBackWatch(sessionId: string): void {
  const watch = watches.get(sessionId);
  if (!watch) return;
  watches.delete(sessionId);
  if (watch.debounce) clearTimeout(watch.debounce);
  watch.debounce = null;
  for (const file of watch.paths) {
    try {
      fs.unwatchFile(file, watch.listener);
    } catch {
      // Ignore cleanup failure.
    }
  }
  try {
    watch.detachRunner();
  } catch {
    // Ignore cleanup failure.
  }
}

export function stopAllTokenWriteBackWatches(): void {
  for (const sessionId of [...watches.keys()]) stopTokenWriteBackWatch(sessionId);
}

export function hasTokenWriteBackWatch(sessionId: string): boolean {
  return watches.has(sessionId);
}
