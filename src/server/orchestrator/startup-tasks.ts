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

export interface StartupDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  containerManager: SessionContainerManager | null;
  getBareCacheDir: (repoUrl: string) => string;
  warmSessionForRepo: (repoUrl: string) => Promise<void>;
  credentialStore?: CredentialStore;
}

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

// Scrub stored URLs and carry their hash-keyed secrets, caches, and memory to the clean key.
export async function runRemoteCredentialScrub(
  deps: {
    repoStore: RepoStore;
    sessionManager: SessionManager;
    secretStore?: { scrubCredentialedRepoUrls: () => number };
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
        // A moved bare cache can still carry credentials in its own config.
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

// Preserve the historical hash; repoUrlToHash now strips credentials before hashing.
function hashAsAnOlderBuildDid(repoUrl: string): string {
  return crypto.createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
}

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

async function scrubGitRemotes(dir: string): Promise<boolean> {
  let configPath = path.join(dir, ".git", "config");
  let text = await fs.readFile(configPath, "utf8").catch(() => null);
  if (text === null) {
    configPath = path.join(dir, "config");
    text = await fs.readFile(configPath, "utf8").catch(() => null);
  }
  if (text === null) return false;
  // Avoid spawning git for clean configs; hasUrlCredentials makes the final decision.
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
    // An inherited fetch URL must not become a new explicit pushurl entry.
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

// Run before container discovery so old-image standbys are not adopted; startup rewarms the pool.
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
    for (const session of deps.sessionManager.listAllIncludingWarm()) {
      if (!session.warm) continue;
      try {
        if (session.workspaceDir) {
          // Claimed drafts can already have uploads; preserve them while dropping checkout and overlay.
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

export async function runMcpOAuthStartupRefresh(opts: {
  credentialStore: CredentialStore;
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

export function scheduleStartupTasks(
  startupDeps: StartupDeps,
  migratedRepoUrls: string[],
): ReturnType<typeof setTimeout> {
  const {
    repoStore, sessionManager, chatHistoryManager, usageManager,
    containerManager, warmSessionForRepo, credentialStore,
  } = startupDeps;

  if (credentialStore) {
    void runMcpOAuthStartupRefresh({ credentialStore });
  }

  const fireAndForgetWarm = (url: string): void => {
    warmSessionForRepo(url).catch((err: unknown) => {
      console.error(`[startup-tasks] warm failed for ${url}:`, getErrorMessage(err));
    });
  };

  return setTimeout(() => {
    // Shutdown can close the database before this callback runs.
    try {
      const activeWarmIds = new Set<string>();
      for (const repo of repoStore.list()) {
        if (repo.warmSessionId) activeWarmIds.add(repo.warmSessionId);
      }

      // Remove abandoned drafts so findUngraduatedWarm cannot offer them for reuse.
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
          const containerDown = !!containerManager
            && containerManager.get(repo.warmSessionId)?.status !== "running";
          const cloneMissing = !ws?.workspaceDir || !existsSync(ws.workspaceDir);
          if (cloneMissing || containerDown) {
            console.log(
              `[warm] Stale warm session ${repo.warmSessionId} — ${cloneMissing ? "clone missing" : "standby not running"}, re-warming`,
            );
            if (containerManager?.isStandby(repo.warmSessionId)) {
              containerManager.destroy(repo.warmSessionId).catch((err: unknown) => {
                console.error(`[warm] Failed to destroy stale standby:`, getErrorMessage(err));
              });
            }
            // The earlier scan spared this pointed-to row; clearing the pointer alone leaves it reusable.
            deleteSession(sessionManager, repo.warmSessionId, chatHistoryManager, usageManager);
            repoStore.setWarmSessionId(repo.url, undefined);
            fireAndForgetWarm(repo.url);
          } else {
            console.log(`[warm] Warm session ${repo.warmSessionId} validated (clone + standby)`);
          }
        }
      }
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
    runner.dispose({ force: true });
  }
}

// Worker death may emit no agent_error; rescue history before disposal.
export function preservePartialTurnOnWorkerLoss(
  sessionId: string,
  runner: SessionRunnerInterface,
  chatHistoryManager: ChatHistoryManager,
  notice: string,
): void {
  try {
    if (runner.running) {
      // Include steered messages and cards; idle accumulators may duplicate a completed turn.
      persistTurnInProgress(chatHistoryManager, runner, sessionId);
    }
    // A reattached idle runner may still have in-progress rows left in the database.
    chatHistoryManager.finalizeInProgress(sessionId);
    emitNoticePostTurn(
      (m) => runner.emitMessage(m),
      chatHistoryManager,
      sessionId,
      notice,
      "warn",
    );
  } catch (err) {
    // History failures must not prevent disposal.
    console.error(`[container] Failed to preserve partial turn for ${sessionId}:`, err);
  }
}

export function setupContainerHealthMonitoring(
  containerManager: SessionContainerManager,
  runnerRegistry: SessionRunnerRegistry,
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void,
  loopDetector: SessionLoopDetector = createSessionLoopDetector(),
  oomBreaker?: SessionOomCircuitBreaker,
  chatHistoryManager?: ChatHistoryManager,
  onContainerExited?: (sessionId: string) => void,
): void {
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
    // Report before disposal. Exit 137 is a fallback when Docker omits the OOM event.
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

  // Repeated creation can trip the breaker even when exits lack usable OOM signals.
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

  // Service exits affect diagnostics, not the agent container's lifecycle.
  containerManager.on("service_exited", (sessionId, info) => {
    const svcName = info.serviceName;
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
        serviceName: info.serviceName,
        containerId: info.containerId,
      });
    }
    const logText = info.oom
      ? `[compose] ${svcName} was OOM-killed (exit ${info.exitCode}). Increase memory limits in docker-compose.yml or reduce service workload.`
      : `[compose] ${svcName} exited with code ${info.exitCode}.`;
    if (broadcastLog) broadcastLog(sessionId, "server", logText);
    runner.emitMessage(agentLogAppend("server", logText));
  });

  // Sidecar churn belongs in operator logs; user Compose settings cannot fix these containers.
  containerManager.on("session_child_exited", (sessionId, info) => {
    const what = info.egressSidecar ? "egress sidecar" : "non-service child container";
    const how = info.oom ? "OOM-killed" : "exited";
    console.log(
      `[container] Session ${sessionId} ${what} ${how} (container=${info.containerId}, exit=${info.exitCode})`,
    );
  });
}
