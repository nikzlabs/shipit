/**
 * Mid-turn OAuth token publication (docs/153).
 *
 * `syncAgentTokenBack` runs at turn END (`finalizeSessionAgentEnvironment`).
 * That is too late. When a session's CLI rotates the shared rotating refresh
 * token mid-turn, the previous token is invalidated upstream *immediately*,
 * but the orchestrator source keeps serving it until the turn finishes — on a
 * busy host, many minutes later. Every session that starts a turn in that
 * window runs `syncAgentTokenIn`, pulls the dead source token, and 401s with
 * "Not logged in · Please run /login". With N containers on one provider
 * account, a single mid-turn rotation poisons every session that starts during
 * the rest of that turn — the widest stale window in the credential design.
 *
 * This module closes it by watching the session's token file(s) for the
 * duration of the turn and running the EXISTING sync-back the moment one
 * actually advances. It changes publication LATENCY only:
 *
 *   - The write itself is `syncAgentTokenBack` / `syncProviderAccountTokenBack`
 *     verbatim, including their expiry guard — a session that FAILED to refresh
 *     still cannot clobber a fresher source.
 *   - `sessionTokenIsAheadOfSource` pre-checks that same comparison so an
 *     unrelated rewrite of `.credentials.json` (the CLI churns the `mcpOAuth`
 *     key) doesn't drive a sync-back whose copy is guarded away but whose
 *     trailing recursive chown is not. Debounce + pre-check = no write storm.
 *   - Everything is fault-tolerant and off the turn's critical path: nothing
 *     here is awaited by turn execution, and every failure is logged and
 *     swallowed.
 *
 * Why `fs.watchFile` (stat polling) rather than `fs.watch` (inotify): the file
 * is written by a *different container* into a shared Docker volume and
 * replaced by atomic rename. Path-based stat polling sees both the in-place
 * rewrite and the rename-over regardless of whether inotify events propagate
 * across the mount, and it has no inode-identity failure mode. One stat per
 * token file per {@link TOKEN_WATCH_POLL_INTERVAL_MS} for the duration of a
 * turn is negligible.
 *
 * Lifecycle: the watch lives as long as the CLI PROCESS that can rotate the
 * token, not as long as the turn. Started by `prepareSessionAgentEnvironment`
 * on the turn's own pre-spawn step. Stopped at each point the process can end:
 *
 *   - `finalizeSessionAgentEnvironment`, when no agent process survives the turn;
 *   - `ContainerSessionRunner.setAgent(null)` — a NON-streaming turn's process
 *     exits after finalize has already run, so finalize sees it installed and
 *     keeps the watch; this is where that one is released;
 *   - `ContainerSessionRunner.isStreamingActive = false` — the resident
 *     streaming CLI's genuine exit (every caller has just killed or released it);
 *   - the runner's `disposed` event — the container went with the process;
 *   - a route change, which re-arms against the new account's source.
 *
 * Four stops for one process because the process has four ways to end, and the
 * cost of missing one is asymmetric: an extra stat poll on an idle file is
 * nothing, while stopping early re-opens the bug below.
 *
 * Ending it AT turn end was the docs/153 gap that made Claude accounts need a
 * reconnect roughly daily. A streaming `claude --print --input-format
 * stream-json` process outlives its turn — that is what live steering is — and
 * it refreshes ON ITS OWN SCHEDULE, hours later, with no turn in sight
 * (observed in production: a session whose last turn ran 17h earlier rewrote
 * its `.credentials.json` with a new refresh token at 01:09). Anthropic's
 * refresh tokens are single-use, so that rotation invalidated the copy the
 * orchestrator was still holding; six minutes later the refresher spent that
 * dead copy, the CLI blanked the account's source file, and the next tick read
 * it as `missing_credentials` and asked the user to sign in again. With no
 * observer between turns, the rotation was invisible to every part of the
 * system that needed it.
 *
 * The cost of the longer lifetime is one `stat` per token file per
 * {@link TOKEN_WATCH_POLL_INTERVAL_MS} for as long as a CLI is resident, and
 * nothing else: an idle session's file does not change, so the poller never
 * schedules a publish.
 */

import fs from "node:fs";
import type { AgentId } from "../shared/types/agent-types.js";
import {
  agentTokenFilePaths,
  sessionTokenIsAheadOfSource,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
} from "./token-sync-manager.js";
import { getErrorMessage } from "./validation.js";

/**
 * Stat-poll cadence. Bounds the stale window a mid-turn rotation can open to
 * roughly this plus {@link TOKEN_PUBLISH_DEBOUNCE_MS}, down from "the rest of
 * the turn". Small enough that a sibling session starting a turn almost never
 * lands inside it; large enough that a dozen concurrent sessions cost a
 * handful of stats a second.
 */
export const TOKEN_WATCH_POLL_INTERVAL_MS = 3_000;

/**
 * Settle time after a detected change. The CLI's rotation is a read-modify-
 * write of the same file; debouncing coalesces a burst into one publish and
 * keeps us from reading a half-written file in the (unlikely) case the CLI
 * doesn't write atomically.
 */
export const TOKEN_PUBLISH_DEBOUNCE_MS = 750;

/** A session's live watch. Keyed by sessionId in {@link watches}. */
interface TokenWatch {
  /** `agentId:accountId` — a change means the route moved and the watch must re-arm. */
  routeKey: string;
  paths: string[];
  listener: (curr: fs.Stats, prev: fs.Stats) => void;
  debounce: NodeJS.Timeout | null;
  /**
   * The runner whose `disposed` event tears this watch down. Compared on re-arm:
   * now that a watch outlives its turn, a session can re-arm against a DIFFERENT
   * runner (the container was destroyed and rebuilt), and keeping the old
   * binding would leave the backstop attached to an emitter that will never fire
   * again.
   */
  runner: TokenWatchRunner | undefined;
  /** Detach the runner's `disposed` backstop, if one was registered. */
  detachRunner: () => void;
}

const watches = new Map<string, TokenWatch>();

/** Minimal slice of `ContainerSessionRunner` the backstop needs. */
export interface TokenWatchRunner {
  on(event: "disposed", listener: () => void): unknown;
  off(event: "disposed", listener: () => void): unknown;
}

export interface StartTokenWriteBackWatchOptions {
  credentialsDir: string;
  sessionId: string;
  agentId: AgentId;
  /**
   * docs/150 account route. Set for `kind: "account"` routes so the write-back
   * targets that account's credential root; omitted for the legacy shared root.
   * Callers must skip the reserved `claude-env-oauth` route entirely — it is
   * not refresher-managed and has no source file to publish to.
   */
  accountId?: string;
  /**
   * Runner whose `disposed` event tears the watch down. Since the watch now
   * outlives its turn, this is the primary stop for an idle session that keeps
   * a resident CLI, not just a backstop for a turn that never reaches finalize.
   */
  runner?: TokenWatchRunner;
  /** Overridable for tests. */
  pollIntervalMs?: number;
  debounceMs?: number;
}

/**
 * Begin publishing this session's token rotations to the source as they
 * happen — for the lifetime of the CLI process, not of the turn. Idempotent:
 * re-arming for the same session + route + runner is a no-op, so the per-turn
 * `prepareSessionAgentEnvironment` call can run unconditionally and a watch
 * left running by the previous turn simply continues. A route change (account
 * failover) restarts the watch against the new source.
 *
 * Never throws.
 */
export function startTokenWriteBackWatch(opts: StartTokenWriteBackWatchOptions): void {
  const { credentialsDir, sessionId, agentId, accountId } = opts;
  const routeKey = `${agentId}:${accountId ?? ""}`;
  const existing = watches.get(sessionId);
  if (existing) {
    // Same route AND same runner — already watching exactly this. A different
    // runner re-arms so the `disposed` backstop follows the live container.
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
  if (paths.length === 0) return; // agent has no rotating token file

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
    // Only the sessions map entry proves the watch is still live — a stop()
    // that raced an already-scheduled timer must not publish afterwards.
    if (watches.get(sessionId) !== watch) return;
    try {
      // Pre-check the sync-back's own guard so a non-rotation rewrite (the
      // CLI churns `mcpOAuth` in the same file) costs two reads instead of a
      // recursive chown of the session credentials tree.
      if (!sessionTokenIsAheadOfSource(credentialsDir, sessionId, agentId, accountId)) return;
      if (accountId) {
        // `sessionOwnRoute` — the watch is armed by the turn's own pre-spawn
        // step from the route that turn resolved, so this account is the
        // session's, never a borrowed one. That is what lets the write-back
        // repair a lost marker instead of dropping the rotation (planning#445);
        // a borrow in flight still refuses, from its own marker.
        syncProviderAccountTokenBack(credentialsDir, sessionId, agentId, accountId, { sessionOwnRoute: true });
      } else {
        syncAgentTokenBack(credentialsDir, sessionId, agentId, { sessionOwnRoute: true });
      }
      console.log(
        `[token-publish] published mid-turn ${agentId} token rotation from ${sessionId}${accountId ? ` (account ${accountId})` : ""}`,
      );
    } catch (err) {
      // Credential syncing must never fail a turn — log and wait for the next
      // change, or for the turn-end sync-back.
      console.warn(`[token-publish] mid-turn sync-back failed for ${sessionId}:`, getErrorMessage(err));
    }
  };

  const schedule = (): void => {
    if (watch.debounce) clearTimeout(watch.debounce);
    watch.debounce = setTimeout(publish, debounceMs);
    watch.debounce.unref?.();
  };

  watch.listener = (curr: fs.Stats, prev: fs.Stats): void => {
    // `watchFile` fires on every poll for some platforms/edge cases; compare
    // explicitly so an unchanged file never schedules work. mtimeMs is 0 when
    // the file doesn't exist, so creation registers as a change too.
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) return;
    schedule();
  };

  for (const file of paths) {
    // `persistent: false` — this poller must never hold the process open.
    fs.watchFile(file, { interval, persistent: false }, watch.listener);
  }

  if (opts.runner) {
    const runner = opts.runner;
    const onDisposed = (): void => stopTokenWriteBackWatch(sessionId);
    runner.on("disposed", onDisposed);
    watch.detachRunner = () => runner.off("disposed", onDisposed);
  }

  watches.set(sessionId, watch);
  // Publish once at arm time, not only on an observed change. `fs.watchFile`
  // takes its baseline stat asynchronously, so a write landing between this
  // call and that baseline is invisible to the poller forever. It also picks
  // up a rotation stranded by a previous turn whose finalize never ran (the
  // container was destroyed mid-turn). Guarded by the same
  // `sessionTokenIsAheadOfSource` pre-check, so the normal case — the sync-in
  // just made the session's token equal to the source's — costs two reads.
  schedule();
}

/**
 * Stop publishing for a session. Safe to call when no watch exists (the common
 * case — local runtime, non-container runners, agents without a token file).
 * Cancels any pending debounced publish.
 *
 * Callers are listed in the module docstring — every point at which the CLI
 * process can end, plus route change and shutdown. A turn end that DOES leave a
 * process resident must not call this: that process is exactly the one that
 * rotates between turns.
 */
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
      // Best-effort — an unwatch failure leaves at most one stat poller.
    }
  }
  try {
    watch.detachRunner();
  } catch {
    // The runner may already have dropped its listeners in dispose().
  }
}

/** Tear every watch down (shutdown, and test cleanup). */
export function stopAllTokenWriteBackWatches(): void {
  for (const sessionId of [...watches.keys()]) stopTokenWriteBackWatch(sessionId);
}

/** Whether a session is currently being watched. Exposed for tests. */
export function hasTokenWriteBackWatch(sessionId: string): boolean {
  return watches.has(sessionId);
}
