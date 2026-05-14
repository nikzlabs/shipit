import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import type { GitManager } from "../shared/git.js";
import simpleGit from "simple-git";
import { generateBranchPrefix, repoUrlToHash, pushToOrigin, fetchAndResolveDefaultBranch } from "./git-utils.js";
import { isNonFastForwardError } from "./services/git.js";
import { SessionContainerManager, resolveAgentDockerLimits } from "./session-container.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import type { SessionRunnerFactory, SessionRunnerInterface } from "./session-runner.js";
import { SessionRunnerRegistry } from "./session-runner.js";
import { cleanupOrphanComposeResources } from "./container-discovery.js";
import { createSessionLoopDetector } from "./loop-detector.js";
import type { SessionLoopDetector } from "./loop-detector.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { createDockerProxy, resolveOwnContainerIp } from "./docker-proxy.js";
import type { SessionInfo as DockerProxySessionInfo } from "./docker-proxy.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import { getErrorMessage } from "./validation.js";
import { fetchCIFailureLogs, buildCIFixPrompt } from "./services/github.js";
import { deleteSession, markMergedAndPruneExcess } from "./services/session.js";
import { ServiceManager } from "./service-manager.js";
import type { PlatformCredentialProvider } from "./platform-credentials.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { RepoGit } from "./repo-git.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { UsageManager } from "./usage.js";
import type { AuthManager } from "./auth.js";
import type { CodexAuthManager, CodexAuthFailedEvent, CodexAuthPendingEvent } from "./codex-auth.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { CredentialStore } from "./credential-store.js";
import type { SecretStore } from "./secret-store.js";
import type { DatabaseManager } from "../shared/database.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { AgentId, AgentProcess, DockerMemoryStats, WsLogEntry } from "../shared/types.js";
import type { AppDeps, RuntimeMode } from "./app-di.js";
import { SessionRunner } from "./session-runner.js";
import { isUnderEvictionPressure } from "./memory-pressure.js";

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
    const sc = await mgr.create(config);
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

// ---- Idle container enforcement ----

/** Dependencies for idle container enforcement. */
export interface IdleEnforcementDeps {
  containerManager: SessionContainerManager | null;
  credentialStore: CredentialStore;
  runnerRegistry: SessionRunnerRegistry;
  /**
   * Returns the most recent Docker memory snapshot, or `null` when stats
   * aren't available yet. When usage crosses the eviction threshold the
   * enforcer becomes aggressive: bypasses the 60s grace period and drops
   * effective `maxIdleContainers` to 0 so any session without a viewer or
   * running agent is reaped immediately. This is the only release valve
   * when many sessions are concurrently active and the host is running
   * out of headroom — without it, idle eviction won't fire because every
   * session is technically "in use."
   *
   * Optional: when omitted, the enforcer falls back to the legacy
   * non-pressure-aware behavior. Tests that don't care about pressure
   * should leave this off.
   */
  getMemoryStats?: () => DockerMemoryStats | null;
  /**
   * Optional broadcast hook. When provided, the enforcer fires a
   * `session_status` SSE event with `reason: "idle-disposed"` (or
   * `"memory-pressure"`) before tearing down the runner. The orchestrator
   * uses this to surface "Session paused after N minutes idle. Send a
   * message to resume." in the client — without it, the user sees
   * `containerState: missing` in the health strip with no explanation.
   * See docs/124-session-rescue-and-diagnostics §1.6.
   */
  sseBroadcast?: (event: string, data: unknown) => void;
  /**
   * Optional per-session log hook. Mirrors the `session_status` SSE event
   * into the per-session Logs ring buffer so a viewer that reconnects
   * later still sees why their container went away.
   */
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
}

/**
 * Grace period after a viewer detaches before the runner becomes eligible for
 * idle cleanup. Protects against transient WebSocket disconnects (network
 * blips, page reloads, session switches) — a runner whose last viewer just
 * detached is kept around for this window so a quick reconnect doesn't pay
 * the cost of a fresh container start.
 */
export const IDLE_GRACE_PERIOD_MS = 60_000;

/**
 * Create the `enforceIdleContainerLimit` function. When more containers are
 * idle than the configured limit, stop the oldest excess containers and
 * dispose their runners.
 *
 * Important invariants:
 *  - Never disposes a runner whose agent is currently running (`runner.running`).
 *  - Never disposes a runner that lost its last viewer within the grace
 *    period — protects against transient WebSocket disconnects.
 *  - Runner disposal is TOCTOU-safe: state is re-checked at dispose time, and
 *    `runner.dispose()` itself refuses to run while the agent is active.
 *
 * This function MUST NOT be called synchronously from a WebSocket close
 * handler. WebSocket lifecycle is independent from runner/container
 * lifecycle. Schedule via the periodic timer instead.
 */
export function createIdleEnforcer(
  enforceDeps: IdleEnforcementDeps,
): () => void {
  const {
    containerManager, credentialStore, runnerRegistry, getMemoryStats,
    sseBroadcast, broadcastLog,
  } = enforceDeps;

  return () => {
    if (!containerManager) return;

    // When the host is under eviction pressure, ignore the grace period
    // and drop effective maxIdle to 0. Running agents and attached viewers
    // are still off-limits — those are real work, not idle slack.
    const underPressure = getMemoryStats ? isUnderEvictionPressure(getMemoryStats()) : false;
    const maxIdle = underPressure ? 0 : credentialStore.getMaxIdleContainers();
    const now = Date.now();
    const idleSessionIds: string[] = [];

    for (const sc of containerManager.getAll()) {
      if (containerManager.isStandby(sc.sessionId)) continue;
      const runner = runnerRegistry.get(sc.sessionId);
      if (!runner) {
        // Container exists without a runner — orphaned. Eligible for cleanup.
        idleSessionIds.push(sc.sessionId);
        continue;
      }
      if (runner.running) continue;
      if (runner.viewerCount > 0) continue;
      // Skip runners whose last viewer detach was within the grace period —
      // a transient disconnect must never lead to disposal. Under memory
      // pressure we override this: a closed tab is a closed tab, and the
      // host needs the bytes back now.
      if (
        !underPressure
        && runner.lastViewerDetachAt > 0
        && now - runner.lastViewerDetachAt < IDLE_GRACE_PERIOD_MS
      ) {
        continue;
      }
      idleSessionIds.push(sc.sessionId);
    }

    if (idleSessionIds.length > maxIdle) {
      // Map insertion order = oldest first; slice from the front to keep the newest.
      const excess = idleSessionIds.slice(0, idleSessionIds.length - maxIdle);
      for (const sid of excess) {
        // TOCTOU re-check: between the scan and now, the runner may have
        // become active (new viewer attached, agent started). Dispose only
        // if it is still safe to do so. `runner.dispose()` also enforces
        // this at the runner level (defense in depth).
        const runner = runnerRegistry.get(sid);
        if (runner && (runner.running || runner.viewerCount > 0)) {
          continue;
        }
        const reason = underPressure ? "memory-pressure" : "idle-disposed";
        const idleMs = runner && runner.lastViewerDetachAt > 0
          ? Math.max(0, now - runner.lastViewerDetachAt)
          : undefined;
        console.log(
          `[idle-cleanup] Stopping idle container for session ${sid}`
          + ` (reason=${reason}${idleMs !== undefined ? ` idleMs=${idleMs}` : ""})`,
        );
        // Surface the disposal to the user before tearing down. Without
        // this, the user comes back to a tab that just shows
        // `containerState: missing` with no explanation. The SSE event is
        // delivered via the global event channel; the runner-attached
        // emitMessage path is unavailable because we're about to dispose
        // the runner. Per-session Logs ring also gets a copy so a future
        // reconnect / diagnostics dump still has the record.
        // See docs/124-session-rescue-and-diagnostics §1.6.
        if (sseBroadcast) {
          sseBroadcast("session_status", {
            type: "session_status",
            sessionId: sid,
            running: false,
            queueLength: runner?.queueLength ?? 0,
            reason,
            ...(idleMs !== undefined ? { idleMs } : {}),
          });
        }
        if (broadcastLog) {
          const idleLabel = idleMs !== undefined ? `${Math.round(idleMs / 1000)}s` : "idle period";
          const human = reason === "memory-pressure"
            ? `Session container reaped (memory pressure).`
            : `Session container paused after ${idleLabel}. Send a message to resume.`;
          broadcastLog(sid, "server", human);
        }
        containerManager.destroy(sid).catch((err: unknown) => {
          const errMsg = getErrorMessage(err);
          console.error(`[idle-cleanup] Failed to destroy container ${sid}:`, errMsg);
          // The runner is already disposed by the line below — its
          // emitMessage path is gone — so the only durable way to
          // surface this is the per-session log ring. Without it, the
          // user sees a session that disappeared with no log entry
          // explaining the destroy failed.
          if (broadcastLog) {
            broadcastLog(
              sid,
              "server",
              `Failed to destroy idle container: ${errMsg}. Container may still be running on the host.`,
            );
          }
        });
        runnerRegistry.dispose(sid);
      }
    }
  };
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

// ---- Runner registry setup ----

/** Dependencies for runner registry creation. */
export interface RunnerRegistryDeps {
  effectiveRunnerFactory: SessionRunnerFactory | undefined;
  sessionManager: SessionManager;
  createGitManager: (dir: string) => GitManager;
  githubAuthManager: GitHubAuthManager;
  agentFactory: ((agentId: AgentId) => AgentProcess) | undefined;
  chatHistoryManager: ChatHistoryManager;
  autoPushDebounceMs: number;
  sseBroadcast: (event: string, data: unknown) => void;
  enforceIdleContainerLimit: () => void;
  getDepCacheDir: (repoUrl: string) => string;
  /** Per-session ServiceManager registry (compose stacks). */
  serviceManagers: Map<string, ServiceManager>;
  /**
   * Per-session in-flight compose-stop promises. Populated in a runner's
   * `disposed` handler with the promise returned by `mgr.stop()` and cleared
   * when that promise settles. The next `setupServiceManager` for the same
   * session awaits the pending stop before calling `mgr.start()` — without
   * this gate, the old `docker compose down -p shipit-{sid12}` runs in
   * parallel with the new `compose up -p shipit-{sid12}` (same project
   * name = same session ID prefix) and tears down the new agent container
   * as collateral, producing the SIGTERM/recreate loop observed in
   * production. See docs/124-session-rescue-and-diagnostics follow-up.
   */
  composeStopPromises: Map<string, Promise<void>>;
  /** Per-session compose warnings for old-format configs without a ServiceManager. */
  composeWarnings: Map<string, string>;
  /** Sessions where compose is not configured in shipit.yaml. */
  composeNotConfigured: Set<string>;
  /** Container manager for connecting agent containers to compose networks. */
  containerManager: SessionContainerManager | null;
  /**
   * Per-repo secret store. Used to auto-load secrets into compose services on
   * session activation — wired into ServiceManager via its `secretsLoader`
   * callback. Optional so test setups without secrets still work.
   */
  secretStore?: SecretStore;
  /**
   * Provider for `source: platform:*` entries in `x-shipit-secrets`
   * (087 Phase 4). When present, ServiceManager forwards Claude OAuth /
   * GitHub tokens into compose services that declare them. Optional so
   * tests / non-auth setups still work.
   */
  platformCredentials?: PlatformCredentialProvider;
  /**
   * Phase 1 follow-up — when set, ServiceManager uses Docker-secrets
   * isolation instead of env files. See `ServiceManagerOptions.dockerSecretsConfig`
   * for field semantics.
   */
  dockerSecretsConfig?: {
    internalDir: string;
    hostDir?: string;
    entrypointSourcePath: string;
  };
  /**
   * Runtime mode. In `"local"` mode, ServiceManager is not constructed for
   * inner sessions (no Docker → no Compose). The compose-not-configured
   * event is also suppressed at the source so the inner UI doesn't see it
   * for every session creation. See feature 118.
   */
  runtimeMode: RuntimeMode;
  /**
   * Per-session log broadcaster. Routes diagnostic strings into the Logs
   * panel + per-session ring buffer. Wired here so compose-stack failures
   * (`ServiceManager.emit("stack_error")`) and other manager-level signals
   * land in the user-visible Logs view rather than the orchestrator's
   * stdout. See docs/124-session-rescue-and-diagnostics §1.1.
   */
  broadcastLog: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
}

/**
 * Create and configure the SessionRunnerRegistry with all callbacks.
 */
export function createRunnerRegistry(
  registryDeps: RunnerRegistryDeps,
): SessionRunnerRegistry {
  const {
    effectiveRunnerFactory, sessionManager, createGitManager,
    githubAuthManager, agentFactory, chatHistoryManager,
    autoPushDebounceMs, sseBroadcast, enforceIdleContainerLimit,
    getDepCacheDir, serviceManagers, composeStopPromises, composeWarnings, composeNotConfigured, containerManager,
    secretStore, platformCredentials, dockerSecretsConfig, runtimeMode, broadcastLog,
  } = registryDeps;

  return new SessionRunnerRegistry({
    ...(effectiveRunnerFactory ? { runnerFactory: effectiveRunnerFactory } : {}),
    depCacheDirResolver: (sessionId: string) => {
      const session = sessionManager.get(sessionId);
      if (session?.remoteUrl) {
        return getDepCacheDir(session.remoteUrl);
      }
      return undefined;
    },
    onRunnerIdle: () => enforceIdleContainerLimit(),
    onRunnerCreated: (runner) => {
      runner.setSystemTurnDeps({
        agentFactory: (agentId) => {
          if (runner.createAgent) return runner.createAgent(agentId);
          if (agentFactory) return agentFactory(agentId);
          throw new Error("No agent factory available for system turn");
        },
        autoCommit: async (sessionDir, summary) => {
          const git = createGitManager(sessionDir);
          return git.autoCommit(summary);
        },
        scheduleAutoPush: (sessionDir) => {
          if (!githubAuthManager.authenticated) return;
          runner.clearPushTimer();
          runner.setPushTimer(setTimeout(async () => {
            runner.setPushTimer(null);
            try {
              const git = createGitManager(sessionDir);
              const branch = await pushToOrigin(git);
              if (branch) {
                runner.emitMessage({ type: "github_push_result", success: true, message: `Auto-pushed to origin/${branch}`, branch });
              }
            } catch (err) {
              if (isNonFastForwardError(err)) {
                runner.emitMessage({
                  type: "git_push_rejected",
                  reason: "non_fast_forward",
                  message: "Branch has diverged from remote. Rebase needed to update.",
                });
              } else {
                console.error("[system-turn] auto-push failed:", getErrorMessage(err));
              }
            }
          }, autoPushDebounceMs));
        },
        sseBroadcast,
        persistMessage: (sessionId, msg) => chatHistoryManager.append(sessionId, msg),
        resolveAgentSessionId: (sessionId) => sessionManager.get(sessionId)?.agentSessionId,
        replaceInProgress: (sessionId, messages) => chatHistoryManager.replaceInProgress(sessionId, messages),
        finalizeInProgress: (sessionId) => chatHistoryManager.finalizeInProgress(sessionId),
        clearInProgress: (sessionId) => chatHistoryManager.clearInProgress(sessionId),
      });

      // In local mode (dogfooding), the orchestrator can't manage Docker —
      // skip ServiceManager wiring entirely for inner sessions. This also
      // suppresses the noisy `compose_not_configured` event the inner UI
      // would otherwise see on every session creation. Inner-session
      // preview is deferred to Phase 2.
      if (runtimeMode !== "local") {
        // Set up compose ServiceManager if the session has a compose config
        const setupDeps = {
          sessionManager,
          serviceManagers,
          composeStopPromises,
          composeWarnings,
          composeNotConfigured,
          containerManager,
          secretStore,
          platformCredentials,
          dockerSecretsConfig,
          broadcastLog,
        };
        setupServiceManager(runner, setupDeps);

        // Allow re-setup when config files change (e.g. old-format migrated to new)
        if ("onComposeConfigChanged" in runner) {
          (runner as { onComposeConfigChanged?: () => void }).onComposeConfigChanged = () => {
            setupServiceManager(runner, setupDeps);
          };
        }
      }
    },
  });
}

/**
 * Route a `stack_error` from a session's ServiceManager to the per-session
 * Logs panel (via `broadcastLog`) and to attached viewers (via the runner's
 * emitMessage). Exported so the integration test in
 * `integration_tests/stack-error.test.ts` can verify the wiring without
 * needing real Docker or a real compose config.
 *
 * See docs/124-session-rescue-and-diagnostics §1.1.
 */
export function handleStackError(
  runner: SessionRunnerInterface,
  err: Error,
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void,
): void {
  const text = `[compose] Stack error: ${err.message}`;
  if (broadcastLog) broadcastLog(runner.sessionId, "server", text);
  runner.emitMessage({
    type: "log_entry",
    source: "server",
    text,
    timestamp: new Date().toISOString(),
  });
  runner.emitMessage({
    type: "stack_error",
    sessionId: runner.sessionId,
    message: err.message,
  });
}

/** Typeguard for the ContainerSessionRunner subclass without an instanceof import here. */
function isContainerRunner(
  runner: SessionRunnerInterface,
): runner is SessionRunnerInterface & ContainerSessionRunner {
  return runner instanceof ContainerSessionRunner;
}

/**
 * Re-wire a freshly-created runner onto an orphaned ServiceManager that
 * survived the previous runner's `preserveComposeOnDispose` dispose. The
 * compose stack is still running — we only need to attach listeners,
 * reconnect the new agent container to the existing network, and re-arm
 * the install-running gate around the new container's install.
 *
 * Exported for unit-test coverage of the lifecycle handoff
 * (`integration_tests/service-manager-adoption.test.ts`). See
 * docs/127-restart-agent for the full design.
 */
export function adoptExistingServiceManager(
  runner: SessionRunnerInterface,
  mgr: ServiceManager,
  deps: {
    serviceManagers: Map<string, ServiceManager>;
    /** Same map as in setupServiceManager — see RunnerRegistryDeps doc. */
    composeStopPromises: Map<string, Promise<void>>;
    containerManager: SessionContainerManager | null;
    broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
    installPromise: Promise<void> | null;
    /**
     * Fresh closure that reads the session's latest secrets (the OLD
     * closure baked into `mgr` references the disposed runner; safe today
     * because both closures read by sessionId, but defensive in case a
     * future refactor makes the loader less idempotent — e.g. a per-runner
     * secret store wrapper, or a remoteUrl change between disposals).
     */
    secretsLoader?: () => Promise<Record<string, string>>;
  },
): void {
  const { serviceManagers, composeStopPromises, containerManager, broadcastLog, installPromise, secretsLoader } = deps;

  // 1. Attach the new runner's listeners. `setServiceManager` internally
  //    calls `clearServiceManager()` first, but on a freshly-created runner
  //    that's a no-op — there's nothing to clear.
  if (runner.setServiceManager) {
    runner.setServiceManager(mgr);
  }

  // 1b. Replace the manager's secrets loader with the fresh closure scoped
  //     to the new runner. Defensive — see field doc above.
  if (secretsLoader) {
    mgr.setSecretsLoader(secretsLoader);
  }

  // 2. Reconnect the new agent container to the existing compose network.
  //    The old container was destroyed; the network outlived it (compose
  //    only removes networks on `down`, which we deliberately skipped).
  //
  //    CRITICAL: we MUST wait for the new container to exist before
  //    calling connectToNetwork — `SessionContainerManager.connectToNetwork`
  //    looks the container up by sessionId and throws "No container found"
  //    if the entry hasn't been registered yet. The runner factory's
  //    container creation is async; the runner is returned synchronously
  //    with a placeholder workerUrl, and `setWorkerUrl()` is called once
  //    the IP resolves. `whenWorkerReady()` gates on that resolution.
  //
  //    Without this gate, the call fires immediately, throws, gets
  //    swallowed in `.catch()`, and the new agent container is NEVER
  //    joined to the compose network — silently breaking compose DNS for
  //    the agent. That's exactly the regression the feature is supposed
  //    to avoid, just from the other direction.
  if (containerManager && isContainerRunner(runner)) {
    const networkName = `shipit-session-${runner.sessionId}`;
    // Fire-and-forget — the connect must run after worker ready resolves
    // but the parent function returns synchronously. eslint-disable is
    // the documented escape for this pattern (see the lint rule's docs).
    // eslint-disable-next-line no-restricted-syntax -- fire-and-forget after async readiness signal
    void runner
      .whenWorkerReady()
      .then(() => containerManager.connectToNetwork(runner.sessionId, networkName))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          console.warn(
            `[compose:${runner.sessionId}] reconnect to ${networkName} failed:`,
            msg,
          );
        }
      });
  }

  // 3. Re-bind stack_error to the new runner so error logs route to the
  //    right place.
  const stackErrorListener = (err: Error) => {
    handleStackError(runner, err, broadcastLog);
  };
  mgr.on("stack_error", stackErrorListener);

  // 4. Re-arm the install-running gate for the new container's install.
  //    Same race story as initial setup: a compose service that reads
  //    workspace `node_modules` while install is extracting can fail —
  //    the gate retries it instead of latching to `error`.
  if (installPromise) {
    mgr.setInstallRunning(true);
    void installPromise.finally(() => {
      mgr.setInstallRunning(false);
    });
  }

  // 5. Disposed handler — same shape as the create path, including the
  //    preserve-compose escape hatch (chained restartAgent calls).
  runner.on("disposed", () => {
    if (isContainerRunner(runner) && runner.preserveComposeOnDispose) {
      mgr.off("stack_error", stackErrorListener);
      return;
    }
    mgr.off("stack_error", stackErrorListener);
    serviceManagers.delete(runner.sessionId);
    const removeVolumes = isContainerRunner(runner) && runner.removeVolumesOnDispose;
    trackComposeStop(composeStopPromises, runner.sessionId, mgr, { removeVolumes });
  });
}

/**
 * Maximum time we wait for a prior runner's `compose down` before letting
 * the next runner's `compose up` proceed. Compose down for a small stack
 * is usually 2-5 s; we cap at 15 s so a hung `docker compose down` can't
 * block agent restart forever. The race window we're protecting against
 * is bounded — once we've waited this long, the prior down has either
 * completed or is genuinely wedged, and forcing the new up forward is
 * preferable to never recovering.
 */
const COMPOSE_STOP_WAIT_TIMEOUT_MS = 15_000;

/**
 * Register an in-flight `mgr.stop()` so the next `mgr.start()` for the
 * same session awaits it before issuing new compose commands. Without
 * this, the prior runner's `compose down -p shipit-{sid12}` can run in
 * parallel with the new runner's `compose up -p shipit-{sid12}` — same
 * project name = same docker resources, so the old down tears down what
 * the new up just built.
 *
 * The stop promise is cleared from the map when it settles. Exported
 * for unit-test coverage.
 */
export function trackComposeStop(
  composeStopPromises: Map<string, Promise<void>>,
  sessionId: string,
  mgr: { stop: (opts?: { removeVolumes?: boolean }) => Promise<void> },
  opts: { removeVolumes?: boolean } = {},
): void {
  const stopPromise = mgr.stop(opts)
    .catch((err: unknown) => {
      console.error(`[compose:${sessionId}] Failed to stop compose stack:`, err);
    })
    .finally(() => {
      // Only clear our entry — a fresh stop may have replaced it.
      if (composeStopPromises.get(sessionId) === stopPromise) {
        composeStopPromises.delete(sessionId);
      }
    });
  composeStopPromises.set(sessionId, stopPromise);
}

/**
 * Wait for any in-flight `compose down` for this session, bounded by
 * COMPOSE_STOP_WAIT_TIMEOUT_MS. Exported for tests.
 */
export async function awaitComposeStop(
  composeStopPromises: Map<string, Promise<void>>,
  sessionId: string,
): Promise<void> {
  const pending = composeStopPromises.get(sessionId);
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[compose:${sessionId}] Prior stop did not complete within ${COMPOSE_STOP_WAIT_TIMEOUT_MS}ms — proceeding with new start anyway`,
      );
      resolve();
    }, COMPOSE_STOP_WAIT_TIMEOUT_MS);
    timer.unref?.();
  });
  await Promise.race([pending, timeout]);
  if (timer) clearTimeout(timer);
}

/**
 * Create and wire a ServiceManager for a runner's session if compose config
 * is detected. Fire-and-forget — compose stack start is async.
 */
function setupServiceManager(
  runner: SessionRunnerInterface,
  deps: {
    sessionManager: SessionManager;
    serviceManagers: Map<string, ServiceManager>;
    composeStopPromises: Map<string, Promise<void>>;
    composeWarnings: Map<string, string>;
    composeNotConfigured: Set<string>;
    containerManager: SessionContainerManager | null;
    secretStore?: SecretStore;
    platformCredentials?: PlatformCredentialProvider;
    dockerSecretsConfig?: { internalDir: string; hostDir?: string; entrypointSourcePath: string };
    broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
  },
): void {
  const {
    sessionManager,
    serviceManagers,
    composeStopPromises,
    composeWarnings,
    composeNotConfigured,
    containerManager,
    secretStore,
    platformCredentials,
    dockerSecretsConfig,
    broadcastLog,
  } = deps;
  const session = sessionManager.get(runner.sessionId);
  const workspaceDir = session?.workspaceDir ?? runner.sessionDir;

  let shipitConfig;
  try {
    shipitConfig = resolveShipitConfig(workspaceDir);
  } catch {
    return; // Invalid config — skip compose setup
  }

  // Surface config migration warnings in the preview panel.
  // Store in composeWarnings map for replay on viewer attach — at this point
  // (first call) the WS listener may not yet be connected so emitMessage
  // would be lost. On subsequent calls (config re-evaluation), emitMessage
  // works and we also update the map.
  if (shipitConfig.warnings.length > 0) {
    const text = `shipit.yaml needs migration:\n${shipitConfig.warnings.map(w => `• ${w}`).join("\n")}`;
    composeWarnings.set(runner.sessionId, text);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: text });
    runner.on("disposed", () => composeWarnings.delete(runner.sessionId));
  } else if (composeWarnings.has(runner.sessionId)) {
    // Warnings cleared (config was fixed) — remove stale warning
    composeWarnings.delete(runner.sessionId);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: "" });
  }

  // Fire install on the agent container regardless of compose config — projects
  // without a compose stack (like ShipIt itself) still need their dependencies
  // installed. Non-blocking; progress streams via SSE.
  //
  // The returned promise resolves when install fully completes (success,
  // skipped, or error). We bracket the ServiceManager's `installRunning`
  // window around it below so dev servers that race install on a shared
  // bind mount get retried instead of latching to `error`.
  const installCommands = shipitConfig.agent.install;
  let installPromise: Promise<void> | null = null;
  if (installCommands.length > 0 && runner instanceof ContainerSessionRunner) {
    installPromise = runner.runInstall(installCommands).catch((err: unknown) => {
      console.error(`[install:${runner.sessionId}] Install failed:`, getErrorMessage(err));
    });
  }

  if (!shipitConfig.compose) {
    composeNotConfigured.add(runner.sessionId);
    runner.emitMessage({ type: "compose_not_configured", sessionId: runner.sessionId });
    runner.on("disposed", () => composeNotConfigured.delete(runner.sessionId));
    return;
  }
  // Compose is now configured — clear stale not-configured flag
  composeNotConfigured.delete(runner.sessionId);

  // Workspace volume info for compose volume rewriting: user `.:/workspace`
  // bind mounts must map to the same storage as the agent container.
  const wsVolume = process.env.WORKSPACE_VOLUME;
  const wsSubpath = wsVolume ? workspaceDir.replace(/^\/workspace\//, "") : undefined;

  // Secrets loader — resolves to the user-saved secrets for this session's
  // repo. Each session activation reads the latest values from the database,
  // so secrets edited while the session was idle are picked up on next start.
  // Sessions without a remoteUrl (e.g. brand-new local-only ones) get an
  // empty record — services that declare `x-shipit-secrets` will start with
  // those env vars unset until the user configures them.
  const secretsLoader = secretStore
    ? async () => {
        const s = sessionManager.get(runner.sessionId);
        const remoteUrl = s?.remoteUrl;
        if (!remoteUrl) return {};
        return secretStore.loadSecrets(remoteUrl);
      }
    : undefined;

  // ---- Adoption path: orphaned ServiceManager from a previous runner ----
  //
  // When a `restartAgent` recovery flow disposes the runner with
  // `preserveComposeOnDispose = true`, the previous runner's `disposed`
  // handler leaves the ServiceManager in `serviceManagers` so it can
  // be re-wired onto the freshly-created runner. The compose stack is
  // still running — we just need to:
  //   1. Hook the new runner's event listeners onto the existing manager.
  //   2. Re-connect the NEW agent container to the still-existing
  //      `shipit-session-{sid}` network (old container was destroyed).
  //   3. Re-arm the install-running gate around the new container's
  //      install (the workspace volume persists, but a service that
  //      races install on the new container still needs the retry
  //      treatment).
  //   4. Re-bind the `stack_error` listener to the new runner so logs
  //      reach the right place.
  //
  // See docs/127-restart-agent for the full flow.
  const existing = serviceManagers.get(runner.sessionId);
  if (existing) {
    adoptExistingServiceManager(runner, existing, {
      serviceManagers,
      composeStopPromises,
      containerManager,
      broadcastLog,
      installPromise,
      secretsLoader,
    });
    // Clear any stale migration warning — compose is now set up (still).
    composeWarnings.delete(runner.sessionId);
    return;
  }

  const mgr = new ServiceManager({
    sessionId: runner.sessionId,
    workspaceDir,
    composeConfig: shipitConfig.compose,
    workspaceVolume: wsVolume,
    workspaceSubpath: wsSubpath,
    stackName: process.env.DOCKER_STACK,
    secretsLoader,
    platformCredentials,
    ...(dockerSecretsConfig ? { dockerSecretsConfig } : {}),
    networkJoinFn: containerManager
      ? async (networkName: string) => {
          // Connect agent container to compose network
          await containerManager.connectToNetwork(runner.sessionId, networkName);
          // Connect orchestrator container so the preview proxy can reach services
          try {
            const orchestratorId = (await import("node:os")).hostname();
            const docker = containerManager.getDockerClient();
            const network = docker.getNetwork(networkName);
            await network.connect({ Container: orchestratorId });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("already exists")) {
              console.warn(`[compose] Failed to connect orchestrator to ${networkName}:`, msg);
            }
          }
        }
      : undefined,
  });

  serviceManagers.set(runner.sessionId, mgr);
  // Clear any stale migration warning — compose is now set up
  composeWarnings.delete(runner.sessionId);

  // Wire ServiceManager to runner for event relay to WS clients
  if (runner.setServiceManager) {
    runner.setServiceManager(mgr);
  }

  // Pipe `stack_error` into the per-session Logs panel for diagnostic
  // visibility. The throw path inside `mgr.start()` already emits a
  // `compose_error` WS banner (see the `void (async () => …)` block
  // below); the Logs entry here is *additional* — it preserves the
  // failure on the per-session ring buffer so a viewer that connects
  // after the error still sees what went wrong, and so the diagnostics
  // panel (Part 3 of feature 124) has it as one of its sources.
  // We also push a live `log_entry` to currently-attached viewers via
  // `runner.emitMessage`, since the persistent ring buffer alone wouldn't
  // surface to clients that are already connected (their WS handler's
  // wrapped `sessionBroadcastLog` is per-connection and we don't have a
  // reference to it here).
  // See docs/124-session-rescue-and-diagnostics §1.1.
  //
  // Store the bound listener so the runner's dispose handler can detach
  // it without stopping the manager (used by the `preserveComposeOnDispose`
  // adoption path).
  const stackErrorListener = (err: Error) => {
    handleStackError(runner, err, broadcastLog);
  };
  mgr.on("stack_error", stackErrorListener);

  // Open the install-running gate while agent.install is in flight: a service
  // that exits non-zero during this window is retried with backoff instead
  // of being marked `error`. Once install resolves, the gate closes and the
  // manager does one explicit restart pass on services still in `error` /
  // pending-retry state. Skip when there's nothing to wait for.
  if (installPromise) {
    mgr.setInstallRunning(true);
    void installPromise.finally(() => {
      mgr.setInstallRunning(false);
    });
  }

  // Clean up on runner dispose
  runner.on("disposed", () => {
    // Adoption path: the runner was disposed by a `restartAgent` recovery
    // flow that wants the compose stack preserved for the next runner. Detach
    // ONLY this runner's listeners (the new runner will re-attach via
    // adoptExistingServiceManager) and leave the manager in the map.
    if (isContainerRunner(runner) && runner.preserveComposeOnDispose) {
      mgr.off("stack_error", stackErrorListener);
      return;
    }
    serviceManagers.delete(runner.sessionId);
    // Track the in-flight stop so the NEXT setupServiceManager for this
    // session awaits it before calling mgr.start(). Same project name
    // (shipit-{sid12}) means an old `compose down` running in parallel
    // with the new `compose up` would tear down the new agent container.
    const removeVolumes = isContainerRunner(runner) && runner.removeVolumesOnDispose;
    trackComposeStop(composeStopPromises, runner.sessionId, mgr, { removeVolumes });
  });

  // Start the compose stack asynchronously — the full sequence (compose up →
  // network join → IP resolution → event flush) is handled inside mgr.start().
  // Install was already fired above (runs in parallel with compose).
  void (async () => {
    // Gate on any prior runner's pending compose-stop for this session.
    // Bounded to avoid hanging start() forever if `compose down` wedges.
    await awaitComposeStop(composeStopPromises, runner.sessionId);
    try {
      await mgr.start();
      console.log(`[compose:${runner.sessionId}] Compose stack started`);
    } catch (err) {
      const errMsg = getErrorMessage(err);
      console.error(`[compose:${runner.sessionId}] Failed to start compose stack:`, errMsg);
      mgr.startError = errMsg;
      runner.emitMessage({
        type: "compose_error",
        sessionId: runner.sessionId,
        message: errMsg,
      });
      // Also record into the per-session log ring so the Logs panel and the
      // future diagnostics endpoint (docs/124-session-rescue-and-diagnostics)
      // see the failure. Without this, the user gets the PreviewFrame banner
      // but the Logs panel is silent — a viewer who attaches after the fact
      // (or files a bug report) has no record of why the stack didn't come
      // up.
      if (broadcastLog) {
        broadcastLog(runner.sessionId, "server", `[compose] Failed to start: ${errMsg}`);
      }
    }
  })();
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
}

/**
 * Create and configure the PrStatusPoller. Auto-tracks sessions with remoteUrl.
 */
export function createPrStatusPoller(
  pollerDeps: PrPollerDeps,
): PrStatusPoller {
  const {
    deps, githubAuthManager, sessionManager, sseBroadcast,
    runnerRegistry, getBareCacheDir, pruneSessionVolumes,
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
      runner.sendSystemMessage(prompt, "Auto-fixing CI...");
    },
    onMergeDetectedCb: async (sessionId) => {
      try {
        const result = await markMergedAndPruneExcess(
          sessionManager, runnerRegistry, getBareCacheDir, sessionId, pruneSessionVolumes,
        );
        sseBroadcast("session_list", { sessions: result.sessions });
        console.log(`[pr-poller] Post-merge: marked ${sessionId} as merged`);
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
  agentRegistry: AgentRegistry;
  defaultAgentId: AgentId;
  sseBroadcast: (event: string, data: unknown) => void;
}

/** Wire auth event handlers. */
export function wireEventHandlers(eventDeps: EventWiringDeps): void {
  const { authManager, codexAuthManager, agentRegistry, defaultAgentId, sseBroadcast } = eventDeps;

  /** Snapshot the current agent list in the SSE-friendly shape. */
  const agentListPayload = () => ({
    agents: agentRegistry.list().map((a) => ({
      id: a.id, name: a.name, installed: a.installed,
      authConfigured: a.authConfigured, models: a.capabilities.models,
      supportsReview: a.capabilities.supportsReview,
    })),
    defaultAgentId,
  });

  // ---- Claude auth event handlers ----
  authManager.on("auth_url", (url: string) => {
    sseBroadcast("auth_required", { url });
  });

  authManager.on("auth_complete", () => {
    agentRegistry.refreshAuth("claude");
    sseBroadcast("auth_complete", {});
    sseBroadcast("agent_list", agentListPayload());
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
    agentRegistry.refreshAuth("codex");
    sseBroadcast("codex_auth_complete", {});
    sseBroadcast("agent_list", agentListPayload());
  });

  codexAuthManager.on("codex_auth_failed", (ev: CodexAuthFailedEvent) => {
    console.log("[codex-auth] Device flow failed:", ev.reason, ev.message ?? "");
    sseBroadcast("codex_auth_failed", ev);
  });
}

// ---- Session directory creation ----

/** Dependencies for session directory creation. */
export interface SessionDirDeps {
  sessionsRoot: string;
  sessionManager: SessionManager;
}

/**
 * Create a factory function for creating new session directories.
 * The directory is created empty — git worktree setup happens separately.
 */
export function createSessionDirFactory(
  dirDeps: SessionDirDeps,
): (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }> {
  const { sessionsRoot, sessionManager } = dirDeps;

  return async (
    title: string,
  ): Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }> => {
    const appSessionId = crypto.randomUUID();
    const sessionDir = path.join(sessionsRoot, appSessionId);
    const workspaceDir = path.join(sessionDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    sessionManager.track(appSessionId, title, workspaceDir);
    console.log("[server] Created session directory:", sessionDir);

    return { appSessionId, sessionDir, workspaceDir };
  };
}

// ---- Bare cache directory ----

/**
 * Create the `getBareCacheDir` helper — returns the bare repo cache path.
 * Lives under {@link stateDir} (defaults to workspaceDir for back-compat;
 * in local mode, set to a directory outside the visible workspace).
 */
export function createBareCacheDirHelper(
  stateDir: string,
): (repoUrl: string) => string {
  const cacheRoot = path.join(stateDir, "repo-cache");
  return (repoUrl: string): string => {
    return path.join(cacheRoot, repoUrlToHash(repoUrl));
  };
}

/**
 * Create the `getDepCacheDir` helper — returns a per-repo dependency cache
 * directory decoupled from the bare cache. Lives at {stateDir}/dep-cache/{hash}.
 */
export function createDepCacheDirHelper(
  stateDir: string,
): (repoUrl: string) => string {
  const depCacheRoot = path.join(stateDir, "dep-cache");
  return (repoUrl: string): string => {
    return path.join(depCacheRoot, repoUrlToHash(repoUrl));
  };
}

// ---- Warm session pool ----

/** Dependencies for warm session pool. */
export interface WarmPoolDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  createRepoGit: (dir: string) => RepoGit;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  containerManager: SessionContainerManager | null;
  credentialsDir: string;
  getBareCacheDir: (repoUrl: string) => string;
  getDepCacheDir: (repoUrl: string) => string;
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  sseBroadcast: (event: string, data: unknown) => void;
  /**
   * Shared OOM circuit breaker. Standby creation consults it before
   * spawning a container so the breaker stays the single authority over
   * "should we make a container right now?" — defense-in-depth, since
   * the standby ID is freshly allocated and would not normally carry
   * OOM history. If we ever re-warm a session that previously tripped,
   * this check stops the standby from being created at the
   * under-provisioned limit just to OOM again.
   */
  oomBreaker?: SessionOomCircuitBreaker;
}

/**
 * Create the warm session pool functions: `warmSessionForRepo` and
 * `waitForWarmSession`.
 */
export function createWarmPool(
  poolDeps: WarmPoolDeps,
): {
  warmSessionForRepo: (repoUrl: string, opts?: { withStandby?: boolean }) => Promise<void>;
  waitForWarmSession: (repoUrl: string) => Promise<void> | undefined;
} {
  const {
    repoStore, sessionManager, createRepoGit,
    githubAuthManager, credentialStore, containerManager,
    credentialsDir, getBareCacheDir, getDepCacheDir, createSessionDir, sseBroadcast,
    oomBreaker,
  } = poolDeps;

  const warmingInProgress = new Set<string>();
  const warmingPromises = new Map<string, Promise<void>>();

  const warmSessionForRepo = async (repoUrl: string, opts?: { withStandby?: boolean }): Promise<void> => {
    const repo = repoStore.get(repoUrl);
    if (repo?.status !== "ready") return;
    // Don't warm if already has a warm session or is currently warming
    if (warmingInProgress.has(repoUrl)) return;
    if (repo.warmSessionId) {
      const existing = sessionManager.get(repo.warmSessionId);
      if (existing) return;
    }
    warmingInProgress.add(repoUrl);

    // The promise is stored so the claim endpoint can await it instead
    // of falling to the expensive slow path.
    const p = (async () => {
      try {
        const cacheDir = getBareCacheDir(repoUrl);
        // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
        const cacheExists = await fs.stat(cacheDir).then(() => true, () => false);
        if (!cacheExists) return;

        const branchPrefix = generateBranchPrefix();
        const created = await createSessionDir("Warm session");
        const { appSessionId, sessionDir, workspaceDir } = created;

        // Mark as warm before doing git work
        sessionManager.setWarm(appSessionId, true);
        sessionManager.setRemoteUrl(appSessionId, repoUrl);

        const cacheGit = createRepoGit(cacheDir);

        // Refresh remote URL with current token (the bare cache may have a stale
        // token embedded from clone time).
        if (githubAuthManager.authenticated) {
          const freshUrl = githubAuthManager.getAuthenticatedCloneUrl(repoUrl);
          await cacheGit.setRemoteUrl(freshUrl);
        }

        // Fetch latest refs in the bare cache (with 60s TTL). Non-fatal —
        // the real-remote fetch in the workspace clone below (W2) is what
        // actually determines the branch point now — but a cache that
        // can't fetch is surfaced so a stale repo doesn't silently serve
        // warm sessions frozen at an old commit.
        try {
          await cacheGit.fetchCache();
        } catch (fetchErr) {
          console.warn("[warm] Cache fetch failed (non-fatal):", String(fetchErr));
          sseBroadcast("error", {
            message: `Repository cache for ${repoUrl} could not be refreshed — warm sessions may be based on stale code: ${getErrorMessage(fetchErr)}`,
          });
        }

        // Remove the workspace subdir (clone needs it absent)
        await fs.rm(workspaceDir, { recursive: true, force: true });

        // Clone from bare cache into workspace subdir (hardlinked, fast)
        await cacheGit.cloneFromCache(workspaceDir, repoUrl);

        // Configure credentials BEFORE the real-remote fetch below — the
        // workspace clone's origin is the plain (unauthenticated) URL, so
        // a private-repo fetch needs the credential helper in place.
        if (githubAuthManager.authenticated) {
          githubAuthManager.configureGitCredentials(workspaceDir);
        }

        // W2: `cloneFromCache` only snapshotted the (possibly hundreds-of-
        // commits-stale) bare cache. Fetch the real remote in the workspace
        // clone so the warm branch is cut from the genuine latest commit —
        // otherwise the standby container's memory limit is derived from a
        // frozen `shipit.yaml`. Shared helper with the claim path so they
        // can't drift.
        const { resetTarget, fetched } = await fetchAndResolveDefaultBranch(workspaceDir);
        if (!fetched) {
          // The workspace-clone fetch failed — the warm branch is being cut
          // from the (possibly stale) `git clone --local` snapshot. Surface
          // it: a silent no-op fetch here is the W2 root cause.
          console.warn(`[warm] Workspace fetch failed for ${appSessionId} — branching from the bare-cache snapshot, which may be stale`);
          sseBroadcast("error", {
            message: `Warm session for ${repoUrl} may be based on stale code — could not fetch the latest commits.`,
          });
        }
        const branchArgs = ["checkout", "-b", branchPrefix];
        if (resetTarget) branchArgs.push(resetTarget);
        await simpleGit(workspaceDir).raw(branchArgs);

        sessionManager.setBranch(appSessionId, branchPrefix);

        // Store the warm session ID on the repo.
        // Container + runner are created on-demand when the user activates
        // the session (WS connect → activateSession → getOrCreate).
        repoStore.setWarmSessionId(repoUrl, appSessionId);

        // Boot a standby container so the next activation is instant.
        // Defense-in-depth — the breaker is the single authority on
        // "should we make a container right now?". `appSessionId` is
        // brand new so this normally passes; the check matters only if
        // a future re-warm path reuses a tripped session ID. We skip
        // standby creation only (not the rest of the warm flow), so the
        // session is still warmed and ready for on-demand activation —
        // which goes through `createContainerForRunner`, which also
        // consults the breaker.
        const standbyAllowed = opts?.withStandby && containerManager && !oomBreaker?.isTripped(appSessionId);
        if (opts?.withStandby && oomBreaker?.isTripped(appSessionId)) {
          console.warn(`[warm] Skipping standby for ${appSessionId}: OOM circuit breaker tripped`);
        }
        if (standbyAllowed && containerManager) {
          const realCount = containerManager.size - containerManager.standbyCount;
          const maxIdle = credentialStore.getMaxIdleContainers();
          if (realCount < maxIdle) {
            // `buildConfigForWorkspace` reads shipit.yaml so the standby
            // container is provisioned with the user's declared agent
            // resources (memory/cpu/pids) and docker-access capability.
            // Without this entry point, plain `buildConfig` falls back to
            // the manager's defaults (1 GB / 0.5 CPU / 256 pids) — so a
            // repo declaring `agent.memory: 3072` would get a 1 GB
            // container from the warm pool, OOMing on first turn when
            // npm install + claude both run inside the under-provisioned
            // cgroup.
            const config = containerManager.buildConfigForWorkspace({
              sessionId: appSessionId,
              sessionDir,
              workspaceDir,
              credentialsDir,
              depCacheDir: getDepCacheDir(repoUrl),
            });
            // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget in sync warming callback
            containerManager.createStandby(config).then(async (sc) => {
              console.log(`[warm] Standby container ready for ${appSessionId} at ${sc.workerUrl}`);
              // Pre-run install so the user doesn't wait for it on activation.
              // Preview endpoints live on the preview container, not the session container.
              // Warm container ready — compose stack startup handled by ServiceManager
            }).catch((err: unknown) => {
              console.error(`[warm] Standby container failed for ${appSessionId}:`, getErrorMessage(err));
            });
          }
        }

        // Broadcast so client knows the repo is ready for instant sessions
        sseBroadcast("repo_warm_ready", { url: repoUrl, sessionId: appSessionId });

        console.log(`[warm] Warm session ${appSessionId} ready for ${repoUrl}`);
      } catch (err) {
        console.error(`[warm] Failed to warm session for ${repoUrl}:`, getErrorMessage(err));
      } finally {
        warmingInProgress.delete(repoUrl);
        warmingPromises.delete(repoUrl);
      }
    })();
    warmingPromises.set(repoUrl, p);
    return p;
  };

  const waitForWarmSession = (repoUrl: string): Promise<void> | undefined => {
    return warmingPromises.get(repoUrl);
  };

  return { warmSessionForRepo, waitForWarmSession };
}

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
    const allSessions = sessionManager.list();
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
 * Schedule startup tasks: validate warm sessions, re-warm missing, clean up zombies.
 * Returns the timer handle so it can be cleared on shutdown.
 */
export function scheduleStartupTasks(
  startupDeps: StartupDeps,
  migratedRepoUrls: string[],
): ReturnType<typeof setTimeout> {
  const {
    repoStore, sessionManager, chatHistoryManager, usageManager,
    containerManager, warmSessionForRepo,
  } = startupDeps;

  return setTimeout(() => {
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
          void warmSessionForRepo(repo.url);
        } else {
          console.log(`[warm] Warm session ${repo.warmSessionId} validated (clone exists)`);
        }
      }
    }
    // Re-warm repos that have no warm session at all (+ migrated repos)
    for (const url of migratedRepoUrls) {
      void warmSessionForRepo(url);
    }
    for (const repo of repoStore.list()) {
      if (!repo.warmSessionId && repo.status === "ready"
          && !migratedRepoUrls.includes(repo.url)) {
        void warmSessionForRepo(repo.url);
      }
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
 */
export function handleContainerExited(
  sessionId: string,
  exitCode: number | undefined,
  error: string | undefined,
  runnerRegistry: SessionRunnerRegistry,
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void,
): void {
  console.error(`[container] Session ${sessionId} container exited: ${error ?? "unknown"}`);
  const exitDetail = error
    ? `: ${error}`
    : exitCode !== undefined && exitCode !== 0
      ? ` (exit ${exitCode}${exitCode === 137 ? ", likely OOMKilled" : ""})`
      : "";
  if (broadcastLog) {
    broadcastLog(sessionId, "server", `Session container exited unexpectedly${exitDetail}.`);
  }
  const runner = runnerRegistry.get(sessionId);
  if (runner) {
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
 * Wire container health monitoring — notify viewers and clean up when
 * a container dies unexpectedly (OOM, crash).
 */
export function setupContainerHealthMonitoring(
  containerManager: SessionContainerManager,
  runnerRegistry: SessionRunnerRegistry,
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void,
  loopDetector: SessionLoopDetector = createSessionLoopDetector(),
  oomBreaker?: SessionOomCircuitBreaker,
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
    //   1. error === "Out of memory" — `container-health.ts` set this
    //      from a Docker `oom` event.
    //   2. exitCode === 137 — the cgroup OOM-killer's SIGKILL signature.
    //      Docker emits both `oom` and `die` on an OOM, but event
    //      ordering is daemon-dependent; with cgroup v2 the `oom`
    //      event is sometimes not emitted at all. When `die` arrives
    //      first our handler deletes the container from the map and
    //      the subsequent `oom` event hits the "container not found"
    //      early-out, losing the OOM signal. 137 with no other emitter
    //      means an external SIGKILL, which inside a memory-limited
    //      cgroup is overwhelmingly the kernel OOM-killer.
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
    handleContainerExited(sessionId, exitCode, error, runnerRegistry, broadcastLog);
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
    runner.emitMessage({
      type: "log_entry",
      source: "server",
      text: logText,
      timestamp: new Date().toISOString(),
    });
  });
}

// ---- Graceful shutdown ----

/** Dependencies for shutdown hook. */
export interface ShutdownDeps {
  startupTimer: ReturnType<typeof setTimeout>;
  authManager: AuthManager;
  codexAuthManager: CodexAuthManager;
  runnerRegistry: SessionRunnerRegistry;
  dockerProxyServer: HttpServer | null;
  containerManager: SessionContainerManager | null;
  databaseManager: DatabaseManager;
}

/**
 * Register the graceful shutdown hook on the Fastify app.
 */
export function registerShutdownHook(
  app: FastifyInstance,
  shutdownDeps: ShutdownDeps,
): void {
  app.addHook("onClose", async () => {
    clearTimeout(shutdownDeps.startupTimer);
    shutdownDeps.authManager.kill();
    shutdownDeps.codexAuthManager.kill();
    shutdownDeps.runnerRegistry.disposeAll();
    if (shutdownDeps.dockerProxyServer) {
      await new Promise<void>((resolve) => shutdownDeps.dockerProxyServer!.close(() => resolve()));
    }
    if (shutdownDeps.containerManager) {
      await shutdownDeps.containerManager.dispose();
    }
    shutdownDeps.databaseManager.close();
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

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[server] listening on http://0.0.0.0:${port}`);
}
