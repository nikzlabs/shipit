import path from "node:path";
import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import { SessionContainerManager, resolveAgentDockerLimits } from "./session-container.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import type { SessionRunnerFactory, SessionRunnerRegistry } from "./session-runner.js";
import { cleanupOrphanComposeResources } from "./container-discovery.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { createDockerProxy, resolveOwnContainerIp } from "./docker-proxy.js";
import type { SessionInfo as DockerProxySessionInfo } from "./docker-proxy.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import { getErrorMessage } from "./validation.js";
import { fetchCIFailureLogs, buildCIFixPrompt } from "./services/github.js";
import { markMergedAndPruneExcess } from "./services/session.js";
import type { SessionManager } from "./sessions.js";
import { repushAgentToken, repushProviderAccountToken } from "./session-credentials.js";
import type { RepoGit } from "./repo-git.js";
import type { AuthManager } from "./auth.js";
import type { CodexAuthManager, CodexAuthFailedEvent, CodexAuthPendingEvent } from "./codex-auth.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { AgentId, WsLogEntry } from "../shared/types.js";
import type { AppDeps, RuntimeMode } from "./app-di.js";
import { SessionRunner } from "./session-runner.js";

// ---- Re-exports for extracted modules ----
//
// All previously-exported symbols are re-exported here so existing imports
// (e.g. `from "./app-lifecycle.js"`) continue to resolve without changes.
// The implementations live in cohesive sibling modules — see each module's
// docstring for boundaries and rationale.

export {
  createIdleEnforcer,
  IDLE_GRACE_PERIOD_MS,
} from "./idle-enforcer.js";
export type { IdleEnforcementDeps } from "./idle-enforcer.js";

export {
  adoptExistingServiceManager,
  COMPOSE_STOP_WAIT_TIMEOUT_MS,
  trackComposeStop,
  awaitComposeStop,
  handleStackError,
} from "./service-manager-setup.js";

export { createRunnerRegistry } from "./runner-registry-factory.js";
export type { RunnerRegistryDeps } from "./runner-registry-factory.js";

export {
  createSessionDirFactory,
  createBareCacheDirHelper,
  createDepCacheDirHelper,
} from "./session-dir-factory.js";
export type { SessionDirDeps } from "./session-dir-factory.js";

export { createWarmPool } from "./warm-pool-manager.js";
export type { WarmPoolDeps } from "./warm-pool-manager.js";

export {
  runRepoMigration,
  runMcpOAuthStartupRefresh,
  scheduleStartupTasks,
  handleContainerExited,
  setupContainerHealthMonitoring,
} from "./startup-tasks.js";
export type { StartupDeps } from "./startup-tasks.js";

export { registerShutdownHook } from "./shutdown-manager.js";
export type { ShutdownDeps } from "./shutdown-manager.js";

// ---- Types for lifecycle dependencies ----

/** Dependencies needed by container setup. */
export interface ContainerSetupDeps {
  deps: AppDeps;
  isTestMode: boolean;
  credentialsDir: string;
  sessionManager: SessionManager;
  /**
   * Runtime mode. When `"local"`, container construction is skipped entirely
   * (no Docker, no proxy, no health monitor). See feature 118 for the cut
   * between containerized and local modes — and the "isTestMode ≠ runtimeMode
   * === 'local'" hardening note for why these two flags must not be conflated.
   */
  runtimeMode: RuntimeMode;
}

/** Result of container setup. */
export interface ContainerSetupResult {
  containerManager: SessionContainerManager | null;
  dockerProxyServer: HttpServer | null;
}

/**
 * Initialize Docker container manager and Docker API proxy.
 * In test mode, local-runtime mode, or when a custom runner factory is
 * provided, returns nulls (no Docker, no proxy).
 */
export async function setupContainerManager(
  setupDeps: ContainerSetupDeps,
): Promise<ContainerSetupResult> {
  const { deps, isTestMode, credentialsDir: _credentialsDir, sessionManager, runtimeMode } = setupDeps;

  // Local mode (dogfooding): skip Docker entirely. Inner sessions run as
  // in-process SessionRunner instances spawning agent CLI subprocesses; no
  // session containers, no compose for inner sessions, no Docker proxy.
  // Distinct from `isTestMode` — see hardening note in the plan.
  if (runtimeMode === "local") {
    console.log("[server] Runtime mode: local — skipping Docker container setup");
    return { containerManager: null, dockerProxyServer: null };
  }

  let containerManager: SessionContainerManager | null = null;
  if (deps.sessionContainerManager) {
    containerManager = deps.sessionContainerManager;
  } else if (!isTestMode && !deps.runnerFactory) {
    // Production mode: Docker is required
    containerManager = new SessionContainerManager({
      workspaceVolume: process.env.WORKSPACE_VOLUME,
      credentialsVolume: process.env.CREDENTIALS_VOLUME,
      stackName: process.env.DOCKER_STACK,
    });
    const dockerAvailable = await containerManager.isAvailable();
    if (dockerAvailable) {
      await containerManager.ensureNetwork();
      const activeIds = new Set(sessionManager.allIds());
      const orphans = await containerManager.cleanupOrphans(activeIds);
      if (orphans > 0) console.log(`[server] Cleaned up ${orphans} orphan container(s)`);
      const composeOrphans = await cleanupOrphanComposeResources(containerManager.getDockerClient(), activeIds);
      if (composeOrphans > 0) console.log(`[server] Cleaned up ${composeOrphans} orphan compose container(s)`);
      const rediscovered = await containerManager.rediscover(activeIds, (sessionId) => {
        const session = sessionManager.get(sessionId);
        if (!session?.workspaceDir) return undefined;
        const limits = resolveAgentDockerLimits(session.workspaceDir);
        return {
          workspaceDir: session.workspaceDir,
          dockerAccess: limits.dockerAccess,
          resourceLimits: limits.dockerAccess ? {
            memory: limits.memoryLimit,
            cpuQuota: limits.cpuQuota,
            pidsLimit: limits.pidsLimit,
          } : undefined,
        };
      });
      if (rediscovered > 0) console.log(`[server] Rediscovered ${rediscovered} container(s) from previous run`);
      await containerManager.startHealthMonitor();
      console.log("[server] Docker container mode enabled");
    } else {
      throw new Error("Docker is not available (is /var/run/docker.sock mounted?)");
    }
  }

  // ---- Docker API proxy (optional, for Docker-enabled sessions) ----
  let dockerProxyServer: HttpServer | null = null;
  if (containerManager && !isTestMode) {
    try {
      const proxyAdvertiseIp = await resolveOwnContainerIp(process.env.DOCKER_NETWORK);
      const proxy = createDockerProxy({
        getSessionByContainerIp: (ip: string): DockerProxySessionInfo | undefined => {
          const sc = containerManager.getSessionByContainerIp(ip);
          if (!sc) return undefined;
          // dockerAccess, hostWorkspaceDir, and sessionNetworkName are
          // stored on the SessionContainer at creation time — no need to
          // re-read shipit.yaml on every request.
          return {
            sessionId: sc.sessionId,
            hostWorkspaceDir: sc.hostWorkspaceDir,
            dockerAccess: sc.dockerAccess,
            sessionNetworkName: sc.sessionNetworkName,
            resourceLimits: sc.resourceLimits,
          };
        },
      });
      await new Promise<void>((resolve) => {
        proxy.listen(0, "0.0.0.0", () => {
          const addr = proxy.address();
          if (addr && typeof addr === "object") {
            containerManager.setDockerProxy(proxyAdvertiseIp, addr.port, process.env.SESSION_WORKER_DOCKER_IMAGE);
            console.log(`[server] Docker API proxy listening on 0.0.0.0:${addr.port} (advertised as ${proxyAdvertiseIp})`);
          }
          resolve();
        });
        proxy.on("error", (err) => {
          console.warn(`[server] Docker API proxy failed to start: ${err.message}`);
          resolve(); // Non-fatal — Docker-enabled sessions won't work but others will
        });
      });
      dockerProxyServer = proxy;
    } catch (err) {
      console.warn(`[server] Docker API proxy setup skipped: ${(err as Error).message}`);
    }
  }

  return { containerManager, dockerProxyServer };
}

// ---- Runner factory ----

/** Dependencies needed by the runner factory. */
export interface RunnerFactoryDeps {
  deps: AppDeps;
  containerManager: SessionContainerManager | null;
  credentialsDir: string;
  /** Runtime mode — selects ContainerSessionRunner vs in-process SessionRunner. */
  runtimeMode: RuntimeMode;
  /**
   * Optional per-session log ring writer. When provided, container
   * creation failures (which would otherwise live only in
   * `lastCreateError` until the next successful create wipes them)
   * also land in `recentLogs`, so a copied diagnostic preserves the
   * failure history.
   */
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
  /**
   * OOM circuit breaker, shared with `setupContainerHealthMonitoring`.
   * When tripped for a session, container creation is refused with a
   * clear error rather than entering the destroy/recreate loop. The
   * breaker is reset by user-initiated restart endpoints — see
   * `services/recovery.ts`.
   */
  oomBreaker?: SessionOomCircuitBreaker;
}

/**
 * Single entry point for creating a container and wiring it to a runner.
 *
 * Both runner-factory paths that materialize a new container — the
 * standby-fallback path (after the in-progress standby timed out) and the
 * fresh-create path (no existing or stale container) — go through here.
 * Keeping the [destroy-existing → build config → create → wire runner →
 * handle failure] sequence in one place means the per-session resource
 * limits and error-handling stay in lock-step across all real container
 * creation flows.
 *
 * The warm-pool standby creator does NOT go through this helper because
 * it produces a standby (no runner to wire) and reports failures
 * differently — it uses `mgr.createStandby` + `mgr.buildConfigForWorkspace`
 * directly.
 */
async function createContainerForRunner(opts: {
  mgr: SessionContainerManager;
  runner: ContainerSessionRunner;
  sessionId: string;
  /** Parent session dir (workspaceDir's parent — used for uploads mount etc). */
  sessionDir: string;
  workspaceDir: string;
  credentialsDir: string;
  depCacheDir?: string;
  /** Destroy any existing (stale) container under this sessionId first. */
  destroyExisting: boolean;
  /** Optional qualifier appended to the failure broadcast (e.g. "from standby fallback"). */
  failureContext?: string;
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
  /** OOM circuit breaker — when tripped, creation is refused. */
  oomBreaker?: SessionOomCircuitBreaker;
}): Promise<void> {
  const { mgr, runner, sessionId } = opts;

  // Circuit-break before doing any work. If the breaker is tripped the
  // last few container creates ended in cgroup-OOM; doing it again wastes
  // host memory and the user just sees more spinners. Refuse with a
  // greppable error that the SessionHealthStrip surfaces directly.
  if (opts.oomBreaker?.isTripped(sessionId)) {
    const errMsg = `Session disabled — agent container OOM-killed too many times. Increase \`agent.memory\` in shipit.yaml and use "Rescue session" to retry.`;
    console.warn(`[container] Refusing to create container for ${sessionId}: OOM circuit breaker tripped`);
    mgr.recordCreateError(sessionId, errMsg);
    opts.broadcastLog?.(sessionId, "server", errMsg);
    runner.dispose({ force: true });
    return;
  }

  try {
    if (opts.destroyExisting) await mgr.destroy(sessionId);
    const config = mgr.buildConfigForWorkspace({
      sessionId,
      sessionDir: opts.sessionDir,
      workspaceDir: opts.workspaceDir,
      credentialsDir: opts.credentialsDir,
      depCacheDir: opts.depCacheDir,
    });
    const createStart = Date.now();
    const sc = await mgr.create(config);
    console.log(`[timing] container.create for ${sessionId} took ${Date.now() - createStart}ms`);
    console.log(`[container] Container ready for ${sessionId} at ${sc.workerUrl}`);
    runner.setWorkerUrl(sc.workerUrl);
    mgr.clearCreateError(sessionId);
  } catch (err) {
    const errMsg = getErrorMessage(err);
    console.error(`[container] Failed to start container for ${sessionId}:`, errMsg);
    // Record so the health endpoint can surface it to the UI — without this
    // async creation failures from the fire-and-forget block are invisible.
    mgr.recordCreateError(sessionId, errMsg);
    // Mirror into the per-session ring — `lastCreateError` is wiped on
    // the next successful create, but a copied diagnostic still shows the
    // failure in recentLogs.
    const qualifier = opts.failureContext ? ` (${opts.failureContext})` : "";
    opts.broadcastLog?.(sessionId, "server", `Container creation failed${qualifier}: ${errMsg}`);
    // Forced — container start failed, the runner is unusable and must be
    // torn down. The agent isn't running on any worker yet, but if some
    // race ever flipped `_isRunning` (early enqueue, etc.), an unforced
    // dispose would silently no-op and leak the registry entry.
    runner.dispose({ force: true });
  }
}

/**
 * Build the effective SessionRunnerFactory.
 *
 * - `containerized` (production): creates ContainerSessionRunner instances
 *   that talk to a per-session Docker worker over HTTP+SSE.
 * - `local` (dogfooding): creates in-process SessionRunner instances; agent
 *   subprocesses are spawned via the process-level `agentFactory` (see
 *   `app-di.ts` `buildLocalAgentFactory`). No containers, no proxy.
 * - Test/custom: `deps.runnerFactory` overrides everything.
 */
export function buildRunnerFactory(
  factoryDeps: RunnerFactoryDeps,
): SessionRunnerFactory | undefined {
  const { deps, containerManager, credentialsDir, runtimeMode, broadcastLog, oomBreaker } = factoryDeps;

  // Explicit injection always wins (tests, custom orchestrations).
  if (deps.runnerFactory) return deps.runnerFactory;

  // Local mode: in-process SessionRunner. Agent subprocesses are launched via
  // the process-level `agentFactory` (claude-adapter / codex-adapter) — there
  // is no `runner.createAgent` because there is no container worker to proxy
  // to. The registry's onRunnerCreated wiring falls through to `agentFactory`
  // when `runner.createAgent` is undefined.
  if (runtimeMode === "local") {
    return (o: Parameters<SessionRunnerFactory>[0]) => {
      return new SessionRunner({
        sessionId: o.sessionId,
        sessionDir: o.sessionDir,
        defaultAgentId: o.defaultAgentId,
      });
    };
  }

  return containerManager ? ((o: Parameters<SessionRunnerFactory>[0]) => {
    const mgr = containerManager;
    // o.sessionDir is session.workspaceDir (e.g. /workspace/sessions/{uuid}/workspace).
    // Derive the parent session dir for container config (uploads mount, etc.).
    const parentSessionDir = path.dirname(o.sessionDir);

    // Check for an existing container (runner was disposed but container kept running).
    const existing = mgr.get(o.sessionId);

    // Reconnect to running container — avoids expensive container restart cycle.
    // If this is a standby container, claim it (removes standby tracking).
    if (existing?.status === "running") {
      mgr.claimStandby(o.sessionId);
      console.log(`[container] Reconnecting to existing container for ${o.sessionId} at ${existing.workerUrl}`);
      return new ContainerSessionRunner({
        sessionId: o.sessionId,
        sessionDir: o.sessionDir,
        defaultAgentId: o.defaultAgentId,
        workerUrl: existing.workerUrl,
      });
    }

    // Wait for in-progress container creation (e.g., standby being built).
    // The standby `create()` call updates the SessionContainer object in-place
    // when finished, so polling `mgr.get()` will see the updated status/URL.
    if (existing?.status === "starting") {
      console.log(`[container] Waiting for in-progress container creation for ${o.sessionId}...`);
      const runner = new ContainerSessionRunner({
        sessionId: o.sessionId,
        sessionDir: o.sessionDir,
        defaultAgentId: o.defaultAgentId,
        workerUrl: "http://0.0.0.0:0",
      });

      void (async () => {
        // Poll the in-progress standby until it's running or the deadline
        // expires. Standby `create()` updates the SessionContainer in-place
        // so polling `mgr.get()` sees the status flip from starting→running.
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const sc = mgr.get(o.sessionId);
          if (sc?.status === "running") {
            mgr.claimStandby(o.sessionId);
            console.log(`[container] Standby container ready for ${o.sessionId} at ${sc.workerUrl}`);
            runner.setWorkerUrl(sc.workerUrl);
            mgr.clearCreateError(o.sessionId);
            return;
          }
          if (!sc) break; // Creation failed and entry was removed
          await new Promise((r) => setTimeout(r, 500));
        }
        // Standby creation failed or timed out — fall back to a fresh container.
        console.log(`[container] Standby not ready, creating fresh container for ${o.sessionId}...`);
        await createContainerForRunner({
          mgr, runner,
          sessionId: o.sessionId,
          sessionDir: parentSessionDir,
          workspaceDir: o.sessionDir,
          credentialsDir,
          depCacheDir: o.depCacheDir,
          destroyExisting: false,
          failureContext: "from standby fallback",
          broadcastLog,
          oomBreaker,
        });
      })();

      return runner;
    }

    // Fresh-create path: no existing container, or a stale (stopping/stopped) one.
    const runner = new ContainerSessionRunner({
      sessionId: o.sessionId,
      sessionDir: o.sessionDir,
      defaultAgentId: o.defaultAgentId,
      workerUrl: "http://0.0.0.0:0", // placeholder — updated after container starts
    });
    console.log(`[container] ${existing ? "Replacing stale" : "Creating"} container for session ${o.sessionId}...`);
    void createContainerForRunner({
      mgr, runner,
      sessionId: o.sessionId,
      sessionDir: parentSessionDir,
      workspaceDir: o.sessionDir,
      credentialsDir,
      depCacheDir: o.depCacheDir,
      destroyExisting: !!existing,
      broadcastLog,
      oomBreaker,
    });

    return runner;
  }) : undefined;
}

// ---- Missing-container reconciler ----

/** Dependencies for the missing-container reconciler. */
export interface MissingContainerReconcilerDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  /** Per-session log ring writer. Required — the whole point is to leave a breadcrumb. */
  broadcastLog: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
  /**
   * Resolves a session's workspace dir + Docker limits, used to re-adopt a
   * live-but-untracked container before force-disposing its runner. Same
   * shape as the resolver `rediscover` uses. Optional — when omitted, the
   * reconciler skips adoption and force-disposes orphaned runners as
   * before (the pre-C3 behavior).
   */
  sessionInfoResolver?: (sessionId: string) => {
    workspaceDir: string;
    dockerAccess: boolean;
    resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
  } | undefined;
}

/**
 * Create a reconciler that detects runners whose container has vanished
 * without a `container_exited` event reaching the orchestrator. This is
 * the inverse of the idle enforcer's "container without runner" check.
 *
 * The Docker event subscriber in `container-health.ts` reconnects with a
 * 5s debounce on stream loss. If a container dies during that window
 * (daemon restart, manual `docker rm`, host OOM-killer), the `die` event
 * is missed and the orchestrator is left thinking the runner is alive
 * while the container is gone. The user sees a stuck session with no
 * error, and the diagnostic shows `containerState: missing` + `runner: <obj>`.
 *
 * This reconciler walks the registry every tick, looks each runner's
 * container up in the manager, and force-disposes any that are orphaned
 * — writing a log-ring entry first so the diagnostic snapshot preserves
 * the reason.
 *
 * Skipped runners:
 *  - Already disposed (registry lazily cleans these up).
 *  - Standby (warm-pool containers don't get registered runners until
 *    they're claimed; transient race during claim is fine — next tick).
 */
export function createMissingContainerReconciler(
  deps: MissingContainerReconcilerDeps,
): () => Promise<void> {
  const { containerManager, runnerRegistry, broadcastLog, sessionInfoResolver } = deps;
  return async () => {
    if (!containerManager) return;
    for (const sid of runnerRegistry.ids()) {
      const runner = runnerRegistry.get(sid);
      if (!runner) continue;
      if (containerManager.isStandby(sid)) continue;
      if (containerManager.get(sid)) continue;
      // Inverse-leak backstop (C3): the runner has no container entry, but
      // a live Docker container may still exist — orphaned because a
      // `die`/`oom` event deleted a healthy container's map entry. Try to
      // re-adopt it before force-disposing; a successful adoption heals
      // the session in place instead of churning another container.
      if (sessionInfoResolver) {
        try {
          const adopted = await containerManager.adoptRunningContainer(sid, sessionInfoResolver);
          if (adopted) {
            console.error(
              `[orphan-runner] Session ${sid} had a live container with no manager entry — re-adopted instead of disposing`,
            );
            broadcastLog(
              sid,
              "server",
              "Recovered a session container that had lost its orchestrator tracking entry — no restart needed.",
            );
            continue;
          }
        } catch (err) {
          console.error(`[orphan-runner] adoptRunningContainer failed for ${sid}:`, err);
        }
      }
      console.error(
        `[orphan-runner] Session ${sid} has runner but container is missing — force-disposing`,
      );
      broadcastLog(
        sid,
        "server",
        "Session container vanished (no Docker exit event received). Send a message to start a fresh container.",
      );
      runner.emitMessage({
        type: "session_status",
        sessionId: sid,
        running: false,
        error: "Session container vanished — no Docker exit event received.",
      });
      runner.dispose({ force: true });
    }
  };
}

// ---- SSE (Server-Sent Events) ----

export interface SSEClient { write: (data: string) => boolean; closed: boolean }

/** Create SSE infrastructure: client set and broadcast function. */
export function createSSE(): {
  sseClients: Set<SSEClient>;
  sseBroadcast: (event: string, data: unknown) => void;
} {
  const sseClients = new Set<SSEClient>();

  /** Send an SSE event to all connected SSE clients. */
  const sseBroadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      if (!client.closed) client.write(payload);
    }
  };

  return { sseClients, sseBroadcast };
}

// ---- PR Status Poller ----

/** Dependencies for PR status poller creation. */
export interface PrPollerDeps {
  deps: AppDeps;
  githubAuthManager: GitHubAuthManager;
  sessionManager: SessionManager;
  sseBroadcast: (event: string, data: unknown) => void;
  runnerRegistry: SessionRunnerRegistry;
  createRepoGit: (dir: string) => RepoGit;
  getBareCacheDir: (repoUrl: string) => string;
  /**
   * Forwarded to `markMergedAndPruneExcess` so the auto-archive of merged
   * sessions reclaims per-session named volumes immediately. The runner is
   * usually already idle-disposed by the time the poller fires, so without
   * this the named volumes would leak until the next orchestrator restart
   * (the disk-janitor sweep catches them eventually, but slower).
   * Omitted in test mode.
   */
  pruneSessionVolumes?: (sessionId: string) => Promise<void>;
  /**
   * docs/145 on-change pre-fetch trigger. Called with a repo URL when the
   * poller detects that the repo's `main` advanced (a PR merged) — the
   * precise moment the bare cache goes stale. The pre-fetcher refreshes the
   * cache off the request path so the next claim can skip its synchronous
   * fetch. Optional — omitted in test mode / when pre-fetch is disabled.
   */
  onRepoMainAdvanced?: (repoUrl: string) => void;
  /**
   * Forwarded to `markMergedAndPruneExcess` so the auto-archive path can
   * actually destroy each excess session's agent container before its
   * workspace dir is unlinked — see `archiveSession`'s docblock for the
   * orphan-inode failure mode this avoids. Optional in test mode.
   */
  containerManager?: SessionContainerManager | null;
}

/**
 * Create and configure the PrStatusPoller. Auto-tracks sessions with remoteUrl.
 */
export function createPrStatusPoller(
  pollerDeps: PrPollerDeps,
): PrStatusPoller {
  const {
    deps, githubAuthManager, sessionManager, sseBroadcast,
    runnerRegistry, createRepoGit, getBareCacheDir, pruneSessionVolumes,
    onRepoMainAdvanced, containerManager,
  } = pollerDeps;

  const prStatusPoller = deps.prStatusPoller ?? new PrStatusPoller({
    githubAuth: githubAuthManager,
    sessionManager,
    sseBroadcast,
    runnerRegistry,
    getSharedRepoDir: getBareCacheDir,
    fetchAndFixCb: async (sessionId, owner, repo, failedChecks) => {
      const runner = runnerRegistry.get(sessionId);
      if (!runner) return;

      const logs = await fetchCIFailureLogs(githubAuthManager, owner, repo, failedChecks, runner.sessionDir);
      if (logs.length === 0) return;
      const prompt = buildCIFixPrompt(logs);

      prStatusPoller.markAutoFixRunning(sessionId);
      runner.dispatch({ text: prompt, activity: "Auto-fixing CI..." });
    },
    onMergeDetectedCb: async (sessionId) => {
      try {
        const result = await markMergedAndPruneExcess(
          sessionManager, runnerRegistry, getBareCacheDir, sessionId,
          pruneSessionVolumes, createRepoGit, githubAuthManager, containerManager,
        );
        sseBroadcast("session_list", { sessions: result.sessions });
        console.log(`[pr-poller] Post-merge: marked ${sessionId} as merged`);
        // docs/145: a merge moved `main`, so the bare cache is now stale.
        // Refresh it off the request path so the next claim can skip its
        // synchronous fetch. Best-effort — the pre-fetcher coalesces/swallows.
        const repoUrl = sessionManager.get(sessionId)?.remoteUrl;
        if (repoUrl) onRepoMainAdvanced?.(repoUrl);
      } catch (err) {
        console.error(`[pr-poller] Post-merge handling failed for ${sessionId}:`, err);
      }
    },
  });

  // Seed in-memory `lastKnown` from persisted PR snapshots so archived
  // sessions show their PR badge / link on the All Sessions dialog after a
  // restart. Must run before `trackSession()` so active sessions don't
  // overwrite their persisted snapshot until a fresh poll arrives.
  prStatusPoller.loadPersisted();

  // Auto-track sessions with remoteUrl so PR status survives server restart
  for (const session of sessionManager.list()) {
    if (session.remoteUrl) {
      prStatusPoller.trackSession(session.id, session.remoteUrl);
    }
  }

  return prStatusPoller;
}

// ---- Log buffer ----

const MAX_LOG_ENTRIES = 500;

/**
 * Create the per-session log buffer and broadcast helper.
 *
 * The buffer is keyed by sessionId so that switching sessions (or opening a
 * new tab into session B) does NOT replay log entries from session A. Every
 * caller must supply the sessionId that the log line belongs to.
 *
 * Background: the buffer used to be process-global and every WS connect
 * replayed the entire history — meaning logs from every session leaked into
 * every other session's terminal panel.
 */
export function createLogBuffer(): {
  getLogBuffer: (sessionId: string) => WsLogEntry[];
  clearLogBuffer: (sessionId: string) => void;
  removeLogBuffer: (sessionId: string) => void;
  broadcastLog: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
} {
  const buffers = new Map<string, WsLogEntry[]>();

  const broadcastLog = (
    sessionId: string,
    source: WsLogEntry["source"],
    text: string,
  ) => {
    const entry: WsLogEntry = {
      type: "log_entry",
      source,
      text,
      timestamp: new Date().toISOString(),
    };
    let buf = buffers.get(sessionId);
    if (!buf) {
      buf = [];
      buffers.set(sessionId, buf);
    }
    buf.push(entry);
    if (buf.length > MAX_LOG_ENTRIES) {
      buffers.set(sessionId, buf.slice(-MAX_LOG_ENTRIES));
    }
  };

  return {
    getLogBuffer: (sessionId: string) => buffers.get(sessionId) ?? [],
    clearLogBuffer: (sessionId: string) => { buffers.set(sessionId, []); },
    removeLogBuffer: (sessionId: string) => { buffers.delete(sessionId); },
    broadcastLog,
  };
}

// ---- Event wiring ----

/** Dependencies for event handler wiring. */
export interface EventWiringDeps {
  authManager: AuthManager;
  codexAuthManager: CodexAuthManager;
  githubAuthManager: GitHubAuthManager;
  agentRegistry: AgentRegistry;
  /** Used to re-register the default provider-account row after a fresh sign-in. */
  providerAccountManager: ProviderAccountManager;
  sseBroadcast: (event: string, data: unknown) => void;
  /** Source-of-truth credentials root — used to re-push a refreshed token into pinned sessions (A3). */
  credentialsDir: string;
  /** Session metadata — used to find sessions pinned to an agent on re-auth (A3). */
  sessionManager: SessionManager;
}

/** Wire auth event handlers. */
export function wireEventHandlers(eventDeps: EventWiringDeps): void {
  const { authManager, codexAuthManager, githubAuthManager, agentRegistry, providerAccountManager, sseBroadcast, credentialsDir, sessionManager } = eventDeps;

  /**
   * A3 (docs/142): after a Claude/Codex re-auth, force the fresh source token
   * into every session already pinned to that agent. Without this a session
   * pinned before the re-login keeps its stale per-session token until its next
   * turn's sync-in — so an idle pinned session would stay 401'd even though the
   * user just re-authed. Best-effort and self-limiting: `repushAgentToken` only
   * overwrites sessions that already hold the agent's token (no cross-agent
   * leak, no-op in local mode where there are no per-session dirs).
   */
  const repushTokenToPinnedSessions = (agentId: AgentId, accountId?: string): void => {
    let healed = 0;
    for (const session of sessionManager.list()) {
      if (!session.agentPinned || session.agentId !== agentId) continue;
      if (accountId && (session.providerRouteKind !== "account" || session.providerRouteId !== accountId)) continue;
      try {
        const wrote = accountId
          ? repushProviderAccountToken(credentialsDir, session.id, agentId, accountId)
          : repushAgentToken(credentialsDir, session.id, agentId);
        if (wrote) healed++;
      } catch (err) {
        console.error(`[auth] A3 token re-push failed for session ${session.id}:`, err);
      }
    }
    if (healed > 0) console.log(`[auth] re-pushed refreshed ${agentId} token into ${healed} pinned session(s)`);
  };

  /** Snapshot the current agent list in the SSE-friendly shape. */
  const agentListPayload = () => ({
    agents: agentRegistry.list().map((a) => ({
      id: a.id, name: a.name, installed: a.installed,
      authConfigured: a.authConfigured, models: a.capabilities.models,
      supportsReview: a.capabilities.supportsReview,
      supportsSteering: a.capabilities.supportsSteering,
      supportedPermissionModes: a.capabilities.supportedPermissionModes,
    })),
  });

  // ---- Claude auth event handlers ----
  authManager.on("auth_url", (url: string) => {
    sseBroadcast("auth_required", { url });
  });

  authManager.on("auth_complete", () => {
    // After a fresh sign-in, re-register the default provider-account row if
    // it was dropped on the previous sign-out. The migration is a no-op when
    // any Claude account row already exists, so re-auth into an existing
    // account stays untouched. See DELETE /api/auth/api-key for the matching
    // teardown.
    providerAccountManager.migrateDefaultAccounts();
    agentRegistry.refreshAuth("claude");
    repushTokenToPinnedSessions("claude");
    sseBroadcast("auth_complete", {});
    sseBroadcast("agent_list", agentListPayload());
    sseBroadcast("provider_accounts", { accounts: providerAccountManager.list() });
  });

  authManager.on("auth_failed", () => {
    console.log("[auth] OAuth flow failed — client should provide API key");
  });

  // ---- Codex (ChatGPT subscription) auth event handlers ----
  // Mirrors the Claude flow but uses the device-authorization grant. Each
  // event is broadcast over SSE because it describes orchestrator-wide
  // agent auth state, not a per-session turn. See feature 119.
  codexAuthManager.on("codex_auth_pending", (ev: CodexAuthPendingEvent) => {
    sseBroadcast("codex_auth_pending", ev);
  });

  codexAuthManager.on("codex_auth_complete", () => {
    // Mirror the Claude flow: re-register the default Codex provider-account
    // row in case the previous sign-out dropped it.
    providerAccountManager.migrateDefaultAccounts();
    agentRegistry.refreshAuth("codex");
    // No-op until Codex registers token files in AGENT_TOKEN_FILES; wired now
    // so extending the token sync to Codex (docs/142) covers A3 automatically.
    repushTokenToPinnedSessions("codex");
    sseBroadcast("codex_auth_complete", {});
    sseBroadcast("agent_list", agentListPayload());
    sseBroadcast("provider_accounts", { accounts: providerAccountManager.list() });
  });

  codexAuthManager.on("codex_auth_failed", (ev: CodexAuthFailedEvent) => {
    console.log("[codex-auth] Device flow failed:", ev.reason, ev.message ?? "");
    sseBroadcast("codex_auth_failed", ev);
  });

  // ---- GitHub auth event handlers ----
  // The orchestrator marks the stored token invalid (via
  // `GitHubAuthManager.markTokenInvalid`) when a git push, fetch, or pull
  // surfaces an "Authentication failed" / "Invalid username or token"
  // error. Without this SSE broadcast the user only sees the failure as
  // a line in the server logs — the UI keeps believing GitHub is
  // authenticated until they reload the page. Push the updated status to
  // every connected client so the sign-in card reappears and a toast
  // points them back to Settings → GitHub.
  githubAuthManager.on("token_invalid", (ev: { reason: string }) => {
    sseBroadcast("github_status", {
      authenticated: false,
      tokenInvalidReason: ev.reason,
    });
  });
}

// ---- Auto-start (production entry point) ----

/**
 * Start the server when running as the entry point (not imported by tests).
 */
export async function autoStart(buildApp: (deps: AppDeps) => Promise<FastifyInstance>): Promise<void> {
  const app = await buildApp({ serveStatic: true });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Backstop against a single async hiccup taking down every session. Node's
  // default on an unhandled rejection is to terminate the process — and this
  // orchestrator owns every live session, so one floating promise (e.g. a
  // WorkerTimeoutError from a wedged session worker that a callsite forgot to
  // catch) would kill them all. The WS dispatcher already catches handler
  // rejections; this is the catch-all for anything else. Log loudly and stay
  // up — same spirit as "WebSocket lifecycle MUST NOT affect server behavior"
  // in CLAUDE.md, extended to worker HTTP timeouts. We deliberately do NOT
  // swallow `uncaughtException`: a thrown (non-promise) error can leave state
  // corrupt, so we let Node's default restart-on-crash handle that case.
  process.on("unhandledRejection", (reason: unknown) => {
    console.error("[orchestrator] unhandled promise rejection (kept process alive):", reason);
  });

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[server] listening on http://0.0.0.0:${port}`);
}
