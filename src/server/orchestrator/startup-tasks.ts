import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { safeSimpleGit } from "../shared/git-hooks-guard.js";
import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { UsageManager } from "./usage.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "./session-runner.js";
import type { CredentialStore } from "./credential-store.js";
import type { LogSource } from "../shared/types.js";
import type { SessionLoopDetector } from "./loop-detector.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { createSessionLoopDetector } from "./loop-detector.js";
import { agentLogAppend } from "./log-emit.js";
import { persistTurnInProgress, emitNoticePostTurn } from "./chat-card-persistence.js";
import { deleteSession } from "./services/session.js";
import { refreshExpiredMcpOAuthTokens } from "./services/mcp-oauth.js";
import { getErrorMessage } from "./validation.js";
import { reclaimRegenerableSessionDirs } from "./disk-utils.js";
import { hasUrlCredentials, repoUrlToHash, stripRemoteUrlCredentials } from "./git-utils.js";

// ---- Migration + startup ----

/** Dependencies for startup tasks. */
export interface StartupDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  containerManager: SessionContainerManager | null;
  getBareCacheDir: (repoUrl: string) => string;
  warmSessionForRepo: (repoUrl: string) => Promise<void>;
  /**
   * Optional — when provided, triggers a one-shot MCP OAuth token refresh
   * sweep at startup (docs/088 Phase 2 follow-up). Tokens whose `expiresAt`
   * is within the 5-minute safety margin are refreshed proactively so the
   * first agent turn after a restart doesn't fail on a stale token.
   *
   * Optional rather than required so existing tests that don't exercise the
   * OAuth surface don't have to thread a `CredentialStore` through.
   */
  credentialStore?: CredentialStore;
}

/**
 * Run repo store migration (derive from existing sessions) and return
 * the list of migrated URLs.
 */
export async function runRepoMigration(
  migrationDeps: { repoStore: RepoStore; sessionManager: SessionManager; getSharedRepoDir: (repoUrl: string) => string },
): Promise<string[]> {
  const { repoStore, sessionManager, getSharedRepoDir } = migrationDeps;
  const migratedRepoUrls: string[] = [];

  if (repoStore.list().length === 0) {
    const allSessions = sessionManager.listAll();
    const seenUrls = new Set<string>();
    for (const session of allSessions) {
      if (session.remoteUrl && !seenUrls.has(session.remoteUrl)) {
        seenUrls.add(session.remoteUrl);
        const repoDir = getSharedRepoDir(session.remoteUrl);
        // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
        const exists = await fs.stat(repoDir).then(() => true, () => false);
        if (exists) {
          repoStore.add(session.remoteUrl);
          repoStore.setReady(session.remoteUrl);
          migratedRepoUrls.push(session.remoteUrl);
          console.log(`[migration] Added repo from session: ${session.remoteUrl}`);
        }
      }
    }
  }

  return migratedRepoUrls;
}

/**
 * docs/262 req 19 — remove credentials an EARLIER build stored in a remote URL.
 *
 * Strip-on-write (`RepoStore.add`, `SessionManager.setRemoteUrl`, `RepoGit`)
 * covers everything written from now on and nothing already on disk. An
 * installation that added `https://x-access-token:<pat>@github.com/o/r.git`
 * before this landed has that token in three places, and only the third is
 * reachable by plugin code — which is why all three are swept here rather than
 * just the rows:
 *
 *   1. the repo row,
 *   2. the session row (`remote_url`),
 *   3. **the session's own checkout**, `<workspaceDir>/.git/config` — mounted
 *      at `/project` in the session container, and readable by every plugin CLI
 *      and (once that surface ships) every plugin service.
 *
 *   4. every **secret** stored for it (`secrets.repo_url` is the raw URL), and
 *   5. every per-repo DIRECTORY, each named after a hash of that URL — the bare
 *      cache, the dependency cache, and the agent's per-repo memory.
 *
 * 4 and 5 are here because the rename is not only a strip: a URL that changes
 * changes every key derived from it. Left alone, the user's stored service
 * secrets and the agent's accumulated memory for that repository would still
 * exist, keyed by a string nothing looks up any more — silently gone, and with
 * the credential still in them. So the sweep carries them across rather than
 * cleaning one key and orphaning the rest (independent review, findings 3 & 6).
 *
 * **Warm sessions are included** (`listAllIncludingWarm`): `listAll` filters
 * `warm = 0`, and a warm row is a real pre-provisioned checkout that a later
 * claim hands to a user — skipping it left the token in the one workspace most
 * likely to be handed out next (independent review, finding 2).
 *
 * Boot-only and idempotent: a clean installation reads a few tiny queries and
 * one small file per session, and rewrites nothing. It converges within one
 * restart, which every deploy performs.
 *
 * Two limits, stated rather than closed. A directory is carried across only
 * when the destination does not already exist — where both spellings have one,
 * the clean one is authoritative and the stale twin is left on disk for the
 * ordinary disk sweeps, because merging two caches is not something this can do
 * safely. And an *archived* session whose checkout was reclaimed has no config
 * to fix; when it is restored, it is re-cloned from the scrubbed row.
 */
export async function runRemoteCredentialScrub(
  deps: {
    repoStore: RepoStore;
    sessionManager: SessionManager;
    secretStore?: { scrubCredentialedRepoUrls: () => number };
    /**
     * Resolvers for the directories named after a repo URL's HASH — bare cache,
     * dep cache, per-repo memory. Keyed by hash rather than by URL because the
     * *old* directory carries the hash of the credentialed URL, which
     * `repoUrlToHash` deliberately no longer produces. Passed in rather than
     * imported so this stays a pure function over its dependencies, and so a
     * caller with no such directories (tests, local mode) can omit them.
     */
    repoKeyedDirs?: ((repoHash: string) => string)[];
  },
): Promise<{ repoRows: number; sessionRows: number; workspaces: number; secrets: number; dirs: number }> {
  const result = { repoRows: 0, sessionRows: 0, workspaces: 0, secrets: 0, dirs: 0 };

  let renamed: { from: string; to: string }[] = [];
  try {
    renamed = deps.repoStore.scrubCredentialedUrls();
    result.repoRows = renamed.length;
  } catch (err) {
    console.warn("[credential-scrub] repo rows failed:", getErrorMessage(err));
  }

  for (const { from, to } of renamed) {
    const oldHash = hashAsAnOlderBuildDid(from);
    const newHash = repoUrlToHash(to);
    for (const resolve of deps.repoKeyedDirs ?? []) {
      try {
        if (await moveKeyedDir(resolve(oldHash), resolve(newHash))) result.dirs++;
        // A bare cache carried across still holds the credential in its OWN
        // origin — the older build cloned it with the credentialed URL.
        await scrubGitRemotes(resolve(newHash));
      } catch (err) {
        console.warn("[credential-scrub] could not carry a per-repo directory across:", getErrorMessage(err));
      }
    }
  }

  try {
    result.secrets = deps.secretStore?.scrubCredentialedRepoUrls() ?? 0;
  } catch (err) {
    console.warn("[credential-scrub] secrets failed:", getErrorMessage(err));
  }

  for (const session of deps.sessionManager.listAllIncludingWarm()) {
    try {
      if (session.remoteUrl && hasUrlCredentials(session.remoteUrl)) {
        // `setRemoteUrl` strips — passing the credentialed value back in IS
        // the fix, and keeps one implementation of what a credential is.
        deps.sessionManager.setRemoteUrl(session.id, session.remoteUrl);
        result.sessionRows++;
      }
      if (session.workspaceDir && await scrubGitRemotes(session.workspaceDir)) {
        result.workspaces++;
      }
    } catch (err) {
      console.warn(`[credential-scrub] session ${session.id} failed:`, getErrorMessage(err));
    }
  }

  if (result.repoRows || result.sessionRows || result.workspaces || result.secrets || result.dirs) {
    console.log(
      `[credential-scrub] removed stored remote credentials: ${result.repoRows} repo row(s), `
      + `${result.sessionRows} session row(s), ${result.workspaces} checkout(s), `
      + `${result.secrets} secret(s), ${result.dirs} per-repo directory(ies) carried across`,
    );
  }
  return result;
}

/**
 * The directory hash an OLDER build produced for a URL: a plain sha256 of the
 * string as typed, credential and all.
 *
 * Deliberately inlined rather than shared with `repoUrlToHash`, which now
 * hashes the STRIPPED URL so a credentialed spelling and a clean one address
 * one cache. That is the right rule going forward and the wrong one for finding
 * what is already on disk — this copy must keep reproducing a historical layout
 * forever, exactly like the docs/252 rule `sessions.ts` inlines for the same
 * reason. Changing `repoUrlToHash` must not change this.
 */
function hashAsAnOlderBuildDid(repoUrl: string): string {
  return crypto.createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
}

/**
 * Carry a per-repo directory from the old URL's hash to the new one. Returns
 * true when it moved. Declines when the source is absent (the ordinary case) or
 * the destination already exists (see the "two limits" note above).
 */
async function moveKeyedDir(from: string, to: string): Promise<boolean> {
  if (from === to) return false;
  // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
  const sourceExists = await fs.stat(from).then(() => true, () => false);
  if (!sourceExists) return false;
  // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
  const destExists = await fs.stat(to).then(() => true, () => false);
  if (destExists) {
    console.warn(`[credential-scrub] left ${from} in place — ${to} already exists`);
    return false;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  console.log(`[credential-scrub] carried ${from} → ${to}`);
  return true;
}

/**
 * Rewrite every remote in `dir`'s git config that carries an embedded
 * credential — fetch URL **and** push URL. Returns true when something was
 * rewritten. Handles a working tree (`.git/config`) and a bare cache
 * (`config`), because both hold a remote and only the first is mounted into a
 * container.
 *
 * Reads the config file first and only spawns git when it actually contains a
 * credentialed URL, so the common (clean) case costs one small read and no
 * process. The rewrite goes through `git remote set-url` rather than editing
 * the file, so git owns the format — and `--push` is passed for a distinct push
 * URL, which a fetch-only rewrite silently left credentialed (independent
 * review, finding 4).
 */
async function scrubGitRemotes(dir: string): Promise<boolean> {
  let configPath = path.join(dir, ".git", "config");
  let text = await fs.readFile(configPath, "utf8").catch(() => null);
  if (text === null) {
    configPath = path.join(dir, "config"); // bare repository
    text = await fs.readFile(configPath, "utf8").catch(() => null);
  }
  if (text === null) return false; // Not a git directory (reclaimed, or a plain dir).
  // Cheap pre-filter: `url = <scheme>://<userinfo>@host…`, `pushurl = …`, or a
  // credential in the query. The authoritative test is `hasUrlCredentials` per
  // remote below.
  if (!/^\s*(push)?url\s*=\s*\S*(:\/\/[^\s/@]+@|\?)/m.test(text)) return false;

  const git = safeSimpleGit(dir);
  const remotes = await git.getRemotes(true);
  let changed = false;
  for (const remote of remotes) {
    const fetchUrl = remote.refs.fetch;
    const pushUrl = remote.refs.push;
    if (fetchUrl && hasUrlCredentials(fetchUrl)) {
      await git.raw(["remote", "set-url", remote.name, stripRemoteUrlCredentials(fetchUrl)]);
      changed = true;
    }
    // Only a DISTINCT push URL needs its own rewrite. With no `pushurl` set,
    // git reports the fetch URL in both slots, and `set-url --push` would then
    // ADD a `pushurl` line that was never there.
    if (pushUrl && pushUrl !== fetchUrl && hasUrlCredentials(pushUrl)) {
      await git.raw(["remote", "set-url", "--push", remote.name, stripRemoteUrlCredentials(pushUrl)]);
      changed = true;
    }
  }
  if (changed) {
    console.log(`[credential-scrub] rewrote credentialed remote(s) in ${configPath}`);
  }
  return changed;
}

/**
 * A warm session does not survive an orchestrator restart. Retire every
 * `warm = 1` row — the pool sessions a repo points at, and the
 * claimed-but-never-graduated drafts nothing points at — clearing each repo's
 * `warmSessionId` and reclaiming the clone.
 *
 * The point is the **standby container**. A standby is a container nobody has
 * claimed, built by the *previous* process from the *previous* worker image,
 * and it is invisible to every mechanism that would otherwise reap it: the idle
 * enforcer skips standbys by design (`idle-enforcer.ts`), and boot's
 * `rediscoverContainers` re-adopts it standby flag and all. So before this it
 * survived indefinitely, and a user claiming that warm session after a deploy
 * got a grandfathered worker — with a pre-install and an overlay base built
 * under the image the deploy just replaced. Grandfathering a *real* session's
 * container across a deploy is deliberate (docs/113: never kill work in
 * flight); a standby has no work in flight, so the same argument says the
 * opposite for it.
 *
 * This kills no container itself — `reapStandbyContainers` does, by label, from
 * `setupContainerManager`. What this owns is the ROW, and the ordering is still
 * load-bearing: **it must run before `setupContainerManager`.** Those rows are
 * what `cleanupOrphanContainers` and `rediscoverContainers` read
 * (`sessionManager.allIds()`), so retiring first means the sweep treats each
 * standby as an orphan and adoption never re-registers one that is about to be
 * reaped. Run it afterwards and the boot ends with adopted, tracked containers
 * whose sessions no longer exist. Guard:
 * `integration_tests/standby-container.test.ts`.
 *
 * The pool is not left cold: every ready repo now has no `warmSessionId`, so
 * {@link scheduleStartupTasks}'s re-warm loop — which already handles exactly
 * that state — makes a fresh warm session with a fresh standby on the new
 * image. Discarding the clone rather than keeping it and re-booting only the
 * container is deliberate: `warmSessionForRepo` is one path that clones AND
 * boots AND pre-installs, so reusing it costs a local hardlinked clone and adds
 * no second warm mechanism to keep in step with the first.
 *
 * Never rejects — a failure here must not stop the orchestrator from booting.
 * Returns the number of warm sessions retired.
 */
export async function retireWarmSessions(deps: {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  chatHistoryManager?: ChatHistoryManager;
  usageManager?: UsageManager;
  presentStore?: { deleteSession: (sessionId: string) => void };
}): Promise<number> {
  let retired = 0;
  try {
    for (const repo of deps.repoStore.list()) {
      if (repo.warmSessionId) deps.repoStore.setWarmSessionId(repo.url, undefined);
    }
    // `listAll` filters `warm = 0`, so the rows this is about are precisely the
    // ones it cannot see.
    for (const session of deps.sessionManager.listAllIncludingWarm()) {
      if (!session.warm) continue;
      try {
        if (session.workspaceDir) {
          // planning#194's helper, not a blanket `rm` of the session root: it
          // takes the checkout AND the overlay upper (the expensive half every
          // hand-rolled reclaim has historically orphaned) and preserves
          // `uploads/`, which a claimed-but-ungraduated draft can already hold.
          const { failed } = await reclaimRegenerableSessionDirs(session.workspaceDir);
          for (const f of failed) {
            console.warn(`[warm] Could not reclaim ${f.dir} for retired warm session ${session.id}: ${f.message}`);
          }
        }
        deleteSession(
          deps.sessionManager, session.id,
          deps.chatHistoryManager, deps.usageManager, undefined, deps.presentStore,
        );
        retired += 1;
      } catch (err) {
        console.warn(`[warm] Failed to retire warm session ${session.id}:`, getErrorMessage(err));
      }
    }
  } catch (err) {
    console.error("[warm] Warm-session retirement failed:", getErrorMessage(err));
  }
  if (retired > 0) {
    console.log(
      `[warm] Retired ${retired} warm session(s) from the previous process — `
      + "their standby containers are reaped as orphans by the boot sweep, and the pool re-warms on the new image",
    );
  }
  return retired;
}

/**
 * docs/088 Phase 2 follow-up: refresh any MCP OAuth tokens whose access
 * tokens are within the safety margin of expiry.
 *
 * The per-turn refresh path in `ws-handlers/agent-execution.ts` covers
 * active sessions, but a long-idle session whose token expired while the
 * orchestrator was down would otherwise carry the stale token into the
 * first turn after restart — the worker would emit a `needs-auth` failure
 * on the next MCP tool call. The startup sweep closes that gap.
 *
 * Fault-tolerant by design: any failures are logged and leave the stale
 * token in place so the worker still surfaces a meaningful
 * `mcp_server_status` failure on use rather than silently dropping the
 * server. Exported so `app-lifecycle.test.ts` can exercise it directly
 * without spinning up the rest of `scheduleStartupTasks`.
 */
export async function runMcpOAuthStartupRefresh(opts: {
  credentialStore: CredentialStore;
  /** Injectable for tests; defaults to global `fetch` via the service. */
  fetchImpl?: typeof fetch;
}): Promise<void> {
  try {
    const result = await refreshExpiredMcpOAuthTokens({
      credentialStore: opts.credentialStore,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    if (result.refreshed.length > 0) {
      console.log(
        `[mcp-oauth] startup refresh rotated ${result.refreshed.length} token(s): ${result.refreshed.join(", ")}`,
      );
    }
    if (result.failed.length > 0) {
      const details = result.failed.map((f) => `${f.source} (${f.error})`).join(", ");
      console.warn(
        `[mcp-oauth] startup refresh failed for ${result.failed.length} source(s): ${details}`,
      );
    }
  } catch (err) {
    console.warn("[mcp-oauth] startup refresh sweep failed:", getErrorMessage(err));
  }
}

/**
 * Schedule startup tasks: validate warm sessions, re-warm missing, clean up zombies.
 * Returns the timer handle so it can be cleared on shutdown.
 *
 * Runs after {@link retireWarmSessions}, which has already dropped every
 * `warm = 1` row and cleared every repo's `warmSessionId`. So on a normal boot
 * the two sweeps below find nothing and the re-warm loop does all the work —
 * they are kept for the rows retirement cannot recognise (a zombie whose warm
 * flag was already cleared, identifiable only by its title) and for a warm
 * session created *after* retirement by some other path.
 */
export function scheduleStartupTasks(
  startupDeps: StartupDeps,
  migratedRepoUrls: string[],
): ReturnType<typeof setTimeout> {
  const {
    repoStore, sessionManager, chatHistoryManager, usageManager,
    containerManager, warmSessionForRepo, credentialStore,
  } = startupDeps;

  // docs/088 Phase 2 follow-up: refresh any MCP OAuth tokens whose access
  // tokens are within the safety margin of expiry. Fire-and-forget — the
  // returned promise is for tests only.
  if (credentialStore) {
    void runMcpOAuthStartupRefresh({ credentialStore });
  }

  // Defensive: `warmSessionForRepo` starts with synchronous DB reads
  // (`repoStore.get`, `sessionManager.get`). If a caller `void`-discards the
  // returned promise, a sync throw turns into an unhandled rejection — which
  // vitest treats as a fatal "UNHANDLED ERRORS" condition. We surface every
  // failure to stderr so production loses no visibility, but we never let one
  // escape as an unhandled rejection.
  const fireAndForgetWarm = (url: string): void => {
    warmSessionForRepo(url).catch((err: unknown) => {
      console.error(`[startup-tasks] warm failed for ${url}:`, getErrorMessage(err));
    });
  };

  return setTimeout(() => {
    // The whole sweep is wrapped because every step calls into the DB-backed
    // stores. A `databaseManager.close()` racing this setTimeout would
    // otherwise throw out of the setTimeout callback (uncaughtException).
    try {
      // Collect current warm session IDs so we can clean up zombies.
      const activeWarmIds = new Set<string>();
      for (const repo of repoStore.list()) {
        if (repo.warmSessionId) activeWarmIds.add(repo.warmSessionId);
      }

      // Delete zombie warm sessions — previously-claimed warm sessions that were
      // never graduated (user clicked "New Session" but never sent a message).
      // Without this, `findUngraduatedWarm()` returns these zombies instead of
      // claiming from the warm pool, preventing re-warming + standby.
      // Also cleans up already-unflagged zombies (title "Warm session", no messages).
      let zombieCount = 0;
      for (const id of sessionManager.allIds()) {
        if (activeWarmIds.has(id)) continue;
        const s = sessionManager.get(id);
        if (s?.warm || (s?.title === "Warm session" && !s.archived)) {
          deleteSession(sessionManager, id, chatHistoryManager, usageManager);
          zombieCount++;
        }
      }
      if (zombieCount > 0) {
        console.log(`[warm] Deleted ${zombieCount} stale ungraduated warm session(s)`);
      }

      for (const repo of repoStore.list()) {
        if (repo.warmSessionId && repo.status === "ready") {
          const ws = sessionManager.get(repo.warmSessionId);
          if (!ws?.workspaceDir || !existsSync(ws.workspaceDir)) {
            console.log(`[warm] Stale warm session ${repo.warmSessionId} — clone missing, re-warming`);
            if (containerManager?.isStandby(repo.warmSessionId)) {
              containerManager.destroy(repo.warmSessionId).catch((err: unknown) => {
                console.error(`[warm] Failed to destroy stale standby:`, getErrorMessage(err));
              });
            }
            repoStore.setWarmSessionId(repo.url, undefined);
            fireAndForgetWarm(repo.url);
          } else {
            console.log(`[warm] Warm session ${repo.warmSessionId} validated (clone exists)`);
          }
        }
      }
      // Re-warm repos that have no warm session at all (+ migrated repos).
      for (const url of migratedRepoUrls) {
        fireAndForgetWarm(url);
      }
      for (const repo of repoStore.list()) {
        if (!repo.warmSessionId && repo.status === "ready"
            && !migratedRepoUrls.includes(repo.url)) {
          fireAndForgetWarm(repo.url);
        }
      }
    } catch (err) {
      console.error("[startup-tasks] background sweep failed:", getErrorMessage(err));
    }
  }, 0);
}

// ---- Container health monitoring ----

/**
 * Handle a `container_exited` event for the agent container. Extracted from
 * the inline subscriber in `setupContainerHealthMonitoring` so tests can
 * exercise the wiring without spinning up Docker.
 *
 * Writes a breadcrumb to the per-session log ring BEFORE disposing the
 * runner. `runner.emitMessage` buffers into the turn-event log which is
 * discarded on dispose, and `console.error` doesn't surface in the
 * diagnostics endpoint — so without `broadcastLog`, the diagnostic
 * snapshot 70 minutes later shows only "Agent process started" and no
 * trace of the failure.
 *
 * Also finalizes any in-flight turn's chat history before dispose. The
 * agent.on("error") path in `wireAgentListeners` preserves a partial turn
 * by flipping in-progress rows to permanent, but an OOM that kills the
 * whole container yields no `agent_error` SSE event — only Docker's
 * `die`/`oom` event reaches the orchestrator, and without this rescue the
 * next turn's first `agent_tool_result` calls `replaceInProgress`, which
 * deletes the orphaned in-progress rows of the OOM'd turn. The user loses
 * everything the agent produced before the crash. For active turns, mirror
 * the error-handler shape: persist `runner.chatMessageGroups` as in-progress,
 * finalize, then append a synthetic assistant error so the failure is visible
 * inline. For idle runners, never write `chatMessageGroups`; they may contain
 * the last completed turn and would duplicate already-finalized history.
 */
export function handleContainerExited(
  sessionId: string,
  exitCode: number | undefined,
  error: string | undefined,
  runnerRegistry: SessionRunnerRegistry,
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void,
  chatHistoryManager?: ChatHistoryManager,
): void {
  console.error(`[container] Session ${sessionId} container exited: ${error ?? "unknown"}`);
  const exitDetail = error
    ? `: ${error}`
    : exitCode !== undefined && exitCode !== 0
      ? ` (exit ${exitCode})`
      : "";
  if (broadcastLog) {
    broadcastLog(sessionId, "server", `Session container exited unexpectedly${exitDetail}.`);
  }
  const runner = runnerRegistry.get(sessionId);
  if (runner) {
    if (chatHistoryManager) {
      preservePartialTurnOnWorkerLoss(
        sessionId,
        runner,
        chatHistoryManager,
        `Session container exited unexpectedly${exitDetail}. The agent's progress up to this point has been preserved.`,
      );
    }
    runner.emitMessage({
      type: "session_status",
      sessionId,
      running: false,
      error: `Session container exited unexpectedly${exitDetail}`,
    });
    // Forced — the underlying container is gone, so the agent process is
    // already dead. We must tear down the runner to release resources.
    runner.dispose({ force: true });
  }
}

/**
 * Flush a runner's in-flight turn state to chat history before its container
 * is torn down, then append `notice` as a visible assistant error. Mirrors
 * the `agent.on("error")` rescue in `wireAgentListeners` — see
 * `handleContainerExited` for why we can't rely on that path when the
 * container dies without emitting `agent_error`.
 *
 * `notice` is the caller's complete sentence rather than a detail fragment
 * because the two callers describe genuinely different discoveries: a Docker
 * `die` we received, and (docs/121 gap E) a container the missing-container
 * reconciler found gone with no exit event at all. Both must leave the same
 * kind of mark — a persisted transcript row, not just a log line — or the
 * user is left with a spinner that stopped for no stated reason.
 */
export function preservePartialTurnOnWorkerLoss(
  sessionId: string,
  runner: SessionRunnerInterface,
  chatHistoryManager: ChatHistoryManager,
  notice: string,
): void {
  try {
    if (runner.running) {
      // The canonical snapshot, not a groups-only rebuild.
      // `replaceInProgress` deletes EVERY in-progress row first, so writing
      // only the assistant groups silently drops the turn's live-steered user
      // messages (docs/140) and its recorded side-channel cards — a voice
      // note, a bug-report card, a sub-agent consult. `persistTurnInProgress`
      // is the one place that re-interleaves all three at their true
      // positions.
      persistTurnInProgress(chatHistoryManager, runner, sessionId);
    }
    // Even when the runner is idle or there are no in-memory groups (e.g.
    // this runner reconnected to a container whose prior turn left
    // in_progress=1 rows in the DB), finalize so those rows are preserved
    // instead of being deleted by the next turn's replaceInProgress.
    chatHistoryManager.finalizeInProgress(sessionId);
    // Emit AND persist. An `append` alone reaches only a future reload: the
    // attached viewer would watch the spinner stop with no explanation,
    // because `session_status.error` is rendered nowhere on the client. Runs
    // after `finalizeInProgress`, so there is no in-progress set for this row
    // to join and the post-turn append is the correct shape.
    emitNoticePostTurn(
      (m) => runner.emitMessage(m),
      chatHistoryManager,
      sessionId,
      notice,
      "warn",
    );
  } catch (err) {
    // Never let a chat-history write failure block the dispose path — that
    // would leak the runner. Log and move on.
    console.error(`[container] Failed to preserve partial turn for ${sessionId}:`, err);
  }
}

/**
 * Wire container health monitoring — notify viewers and clean up when
 * a container dies unexpectedly (OOM, crash).
 */
export function setupContainerHealthMonitoring(
  containerManager: SessionContainerManager,
  runnerRegistry: SessionRunnerRegistry,
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void,
  loopDetector: SessionLoopDetector = createSessionLoopDetector(),
  oomBreaker?: SessionOomCircuitBreaker,
  chatHistoryManager?: ChatHistoryManager,
  onContainerExited?: (sessionId: string) => void,
): void {
  // Shared "breaker just tripped" emission — sends the WS message to
  // attached viewers and the per-session log ring + journalctl line.
  // Idempotent: `trip.justTripped` is true exactly once, so a duplicate
  // call (e.g. exit + loop alert in the same window) no-ops cleanly.
  const emitBreakerTrip = (
    trip: { justTripped: boolean; countInWindow: number; windowMs: number; threshold: number },
    sessionId: string,
    summary: string,
  ): void => {
    if (!trip.justTripped) return;
    const msg = `Session disabled — ${summary}. Increase \`agent.memory\` in shipit.yaml and use "Rescue session" to retry.`;
    console.error(`[oom-breaker] ${msg} (session=${sessionId})`);
    if (broadcastLog) broadcastLog(sessionId, "server", msg);
    const runner = runnerRegistry.get(sessionId);
    runner?.emitMessage({
      type: "session_memory_exhausted",
      sessionId,
      countInWindow: trip.countInWindow,
      windowMs: trip.windowMs,
      threshold: trip.threshold,
    });
  };

  containerManager.on("container_exited", (sessionId, exitCode, error) => {
    // Record agent-container OOM kills BEFORE disposing the runner — the
    // dispose tears down the WS channel, so a `session_memory_exhausted`
    // emit afterwards never reaches attached viewers.
    //
    // Two signals trigger the OOM count, because Docker is unreliable
    // here:
    //   1. error === "Out of memory" — `container-health.ts` attributed
    //      this `die` to a recent `oom` event on the SAME container
    //      incarnation (the label is deliberately dropped when the OOM
    //      can't be pinned to a concrete container).
    //   2. exitCode === 137 — the cgroup OOM-killer's SIGKILL signature.
    //      The label alone can't be relied on: with cgroup v2 the `oom`
    //      event is sometimes not emitted at all, and event ordering is
    //      daemon-dependent — a `die` that arrives BEFORE its `oom` finds
    //      no record to consume. 137 with no other emitter means an
    //      external SIGKILL, which inside a memory-limited cgroup is
    //      overwhelmingly the kernel OOM-killer.
    //
    // Compose-child OOMs go through the `service_exited` path and are
    // not the breaker's concern.
    if (oomBreaker && (error === "Out of memory" || exitCode === 137)) {
      const trip = oomBreaker.recordOom(sessionId);
      const windowLabel = `${Math.round(trip.windowMs / 1000)}s`;
      emitBreakerTrip(
        trip,
        sessionId,
        `agent container OOM-killed ${trip.countInWindow} times in last ${windowLabel}`,
      );
    }
    handleContainerExited(sessionId, exitCode, error, runnerRegistry, broadcastLog, chatHistoryManager);
    onContainerExited?.(sessionId);
  });

  // SIGTERM/recreate loop detector. Field reports show occasional
  // intermittent loops where the same session's container is destroyed
  // and recreated every 30-60s for many minutes. The loop is hard to
  // investigate because it's not reproducible and often clears after
  // an orchestrator restart. We emit a uniquely greppable
  // `LOOP DETECTED` line on both console and the per-session log ring
  // so post-hoc journalctl grep can confirm whether the loop occurred,
  // even after a restart.
  //
  // Belt-and-suspenders for the breaker: if the loop is happening but
  // individual exits aren't reaching the breaker as OOMs (event
  // ordering, exit code 0 from a SIGTERM-handler, etc.), `forceTrip`
  // catches it. After this trips, the runner factory refuses the next
  // create — the loop stops even when no signal cleanly identifies the
  // failure mode.
  containerManager.on("container_started", (sessionId) => {
    const alert = loopDetector.recordContainerStarted(sessionId);
    if (!alert) return;
    const windowLabel = `${Math.round(alert.windowMs / 1000)}s`;
    const msg = `LOOP DETECTED: session ${sessionId} container created ${alert.countInWindow} times in last ${windowLabel} (threshold ${alert.threshold}).`;
    console.error(`[loop-detector] ${msg}`);
    if (broadcastLog) {
      broadcastLog(
        sessionId,
        "server",
        `${msg} Orchestrator is in a destroy/recreate loop — check journalctl for destroyContainer/dispose stack traces around this timestamp.`,
      );
    }
    if (oomBreaker) {
      const trip = oomBreaker.forceTrip(sessionId);
      emitBreakerTrip(
        trip,
        sessionId,
        `${alert.countInWindow} container creation attempts in last ${windowLabel}`,
      );
    }
  });

  // Docker events stream reconnected after a gap. Any die/oom events
  // during the gap were lost — leave a breadcrumb on every active
  // session so anyone diagnosing a "container vanished" report can see
  // the window when events may have been missed. We log to every
  // session because the gap isn't attributable to a specific one.
  containerManager.on("health_monitor_resumed", ({ gapMs }) => {
    const gapLabel = gapMs >= 1000 ? `${Math.round(gapMs / 1000)}s` : `${gapMs}ms`;
    console.warn(`[container-health] Docker events stream resumed after ${gapLabel} gap`);
    if (!broadcastLog) return;
    for (const sc of containerManager.getAll()) {
      broadcastLog(
        sc.sessionId,
        "server",
        `Docker events stream resumed after ${gapLabel} gap — die/oom events during this window may have been missed.`,
      );
    }
  });

  /**
   * Compose-child exit (user service crashed or OOM-killed). Emit a
   * `service_oom` runner message when OOM, and always log to the per-session
   * Logs panel + ring buffer so the user sees the failure immediately
   * instead of waiting ~5 s for `pollStatus` to flip the service to
   * `error` with a generic "Exited with code N" message.
   *
   * We intentionally do NOT touch the runner's lifecycle here — the agent
   * container is fine; only one of its compose siblings died. The
   * ServiceManager's own `pollStatus` handles the status flip and (where
   * applicable) retry-during-install backoff. Our job is just visibility.
   * See docs/124-session-rescue-and-diagnostics §1.2.
   */
  containerManager.on("service_exited", (sessionId, info) => {
    const svcName = info.serviceName ?? "service";
    if (info.oom) {
      console.warn(
        `[container] Session ${sessionId} compose ${svcName} OOM-killed (container=${info.containerId}, exit=${info.exitCode})`,
      );
    } else {
      console.log(
        `[container] Session ${sessionId} compose ${svcName} exited (container=${info.containerId}, exit=${info.exitCode})`,
      );
    }
    const runner = runnerRegistry.get(sessionId);
    if (!runner) return;
    if (info.oom) {
      runner.emitMessage({
        type: "service_oom",
        sessionId,
        ...(info.serviceName ? { serviceName: info.serviceName } : {}),
        containerId: info.containerId,
      });
    }
    const logText = info.oom
      ? `[compose] ${svcName} was OOM-killed (exit ${info.exitCode}). Increase memory limits in docker-compose.yml or reduce service workload.`
      : `[compose] ${svcName} exited with code ${info.exitCode}.`;
    if (broadcastLog) broadcastLog(sessionId, "server", logText);
    runner.emitMessage(agentLogAppend("server", logText));
  });
}
