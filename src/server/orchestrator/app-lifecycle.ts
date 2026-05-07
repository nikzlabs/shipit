import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import type { GitManager } from "../shared/git.js";
import simpleGit from "simple-git";
import { generateBranchPrefix, repoUrlToHash, pushToOrigin } from "./git-utils.js";
import { isNonFastForwardError } from "./services/git.js";
import { SessionContainerManager } from "./session-container.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import type { SessionRunnerFactory, SessionRunnerInterface } from "./session-runner.js";
import { SessionRunnerRegistry } from "./session-runner.js";
import { resolveSessionConfig } from "../shared/session-config.js";
import { cleanupOrphanComposeResources } from "./container-discovery.js";
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
        const cfg = resolveSessionConfig(session.workspaceDir);
        return {
          workspaceDir: session.workspaceDir,
          dockerAccess: cfg.capabilities.docker,
          resourceLimits: cfg.capabilities.docker ? {
            memory: cfg.resources.agent.memory * 1024 * 1024,
            cpuQuota: cfg.resources.agent.cpu * 100_000,
            pidsLimit: cfg.resources.agent.pids,
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
  const { deps, containerManager, credentialsDir, runtimeMode } = factoryDeps;

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
        try {
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
          // Standby creation failed or timed out — create fresh container.
          console.log(`[container] Standby not ready, creating fresh container for ${o.sessionId}...`);
          const sessionConfig = resolveSessionConfig(o.sessionDir);
          const config = mgr.buildConfig({
            sessionId: o.sessionId,
            sessionDir: parentSessionDir,
            workspaceDir: o.sessionDir,
            credentialsDir,
            depCacheDir: o.depCacheDir,
            memoryLimit: sessionConfig.resources.agent.memory * 1024 * 1024,
            cpuQuota: Math.round(sessionConfig.resources.agent.cpu * 100_000),
            pidsLimit: sessionConfig.resources.agent.pids,
            dockerAccess: sessionConfig.capabilities.docker,
          });
          const sc = await mgr.create(config);
          console.log(`[container] Container ready for ${o.sessionId} at ${sc.workerUrl}`);
          runner.setWorkerUrl(sc.workerUrl);
          mgr.clearCreateError(o.sessionId);
        } catch (err) {
          const errMsg = getErrorMessage(err);
          console.error(`[container] Failed to start container for ${o.sessionId}:`, errMsg);
          mgr.recordCreateError(o.sessionId, errMsg);
          // Forced — container start failed, the runner is unusable and must
          // be torn down. The agent isn't actually running on a worker yet.
          runner.dispose({ force: true });
        }
      })();

      return runner;
    }

    // Build config for fresh container creation.
    const sessionConfig = resolveSessionConfig(o.sessionDir);
    const config = mgr.buildConfig({
      sessionId: o.sessionId,
      sessionDir: parentSessionDir,
      workspaceDir: o.sessionDir,
      credentialsDir,
      depCacheDir: o.depCacheDir,
      memoryLimit: sessionConfig.resources.agent.memory * 1024 * 1024,
      cpuQuota: Math.round(sessionConfig.resources.agent.cpu * 100_000),
      pidsLimit: sessionConfig.resources.agent.pids,
      dockerAccess: sessionConfig.capabilities.docker,
    });
    const runner = new ContainerSessionRunner({
      sessionId: o.sessionId,
      sessionDir: o.sessionDir,
      defaultAgentId: o.defaultAgentId,
      workerUrl: "http://0.0.0.0:0", // placeholder — updated after container starts
    });

    // If a stale container exists (stopping/stopped), destroy it first.
    console.log(`[container] ${existing ? "Replacing stale" : "Creating"} container for session ${o.sessionId}...`);
    void (async () => {
      try {
        if (existing) await mgr.destroy(o.sessionId);
        const sc = await mgr.create(config);
        console.log(`[container] Container ready for ${o.sessionId} at ${sc.workerUrl}`);
        runner.setWorkerUrl(sc.workerUrl);
        mgr.clearCreateError(o.sessionId);
      } catch (err) {
        const errMsg = getErrorMessage(err);
        console.error(`[container] Failed to start container for ${o.sessionId}:`, errMsg);
        // Record the error so the health endpoint can surface it to the UI.
        // Without this, async creation failures from the fire-and-forget block
        // are invisible to the client — the user sees "Restarting…" forever.
        mgr.recordCreateError(o.sessionId, errMsg);
        // Forced — container start failed, the runner is unusable and must be
        // torn down. The agent isn't running on any worker yet, but if some
        // race ever flipped `_isRunning` (early enqueue, etc.), an unforced
        // dispose would silently no-op and leak the registry entry.
        runner.dispose({ force: true });
      }
    })();

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
          console.error(`[idle-cleanup] Failed to destroy container ${sid}:`, getErrorMessage(err));
        });
        runnerRegistry.dispose(sid);
      }
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
    getDepCacheDir, serviceManagers, composeWarnings, composeNotConfigured, containerManager,
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

/**
 * Create and wire a ServiceManager for a runner's session if compose config
 * is detected. Fire-and-forget — compose stack start is async.
 */
function setupServiceManager(
  runner: SessionRunnerInterface,
  deps: {
    sessionManager: SessionManager;
    serviceManagers: Map<string, ServiceManager>;
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
  mgr.on("stack_error", (err: Error) => {
    handleStackError(runner, err, broadcastLog);
  });

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
    serviceManagers.delete(runner.sessionId);
    mgr.stop().catch((err: unknown) => {
      console.error(`[compose:${runner.sessionId}] Failed to stop compose stack:`, err);
    });
  });

  // Start the compose stack asynchronously — the full sequence (compose up →
  // network join → IP resolution → event flush) is handled inside mgr.start().
  // Install was already fired above (runs in parallel with compose).
  void (async () => {
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
}

/**
 * Create and configure the PrStatusPoller. Auto-tracks sessions with remoteUrl.
 */
export function createPrStatusPoller(
  pollerDeps: PrPollerDeps,
): PrStatusPoller {
  const {
    deps, githubAuthManager, sessionManager, sseBroadcast,
    runnerRegistry, getBareCacheDir,
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
          sessionManager, runnerRegistry, getBareCacheDir, sessionId,
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

        // Fetch latest refs in the bare cache (with 60s TTL).
        // Non-fatal — cache may not have a reachable remote (e.g. tests).
        try {
          await cacheGit.fetchCache();
        } catch (fetchErr) {
          console.warn("[warm] Cache fetch failed (non-fatal):", String(fetchErr));
        }

        // Remove the workspace subdir (clone needs it absent)
        await fs.rm(workspaceDir, { recursive: true, force: true });

        // Clone from bare cache into workspace subdir (hardlinked, fast)
        await cacheGit.cloneFromCache(workspaceDir, repoUrl);

        // Checkout a new branch from the default branch
        let startPoint: string | undefined;
        try {
          const defaultBranch = await cacheGit.getDefaultBranch();
          if (defaultBranch && !defaultBranch.includes("(")) {
            startPoint = `origin/${defaultBranch}`;
          }
        } catch {
          // Fallback: let git use HEAD
        }

        // Create branch in the session clone
        const branchArgs = ["checkout", "-b", branchPrefix];
        if (startPoint) branchArgs.push(startPoint);
        await simpleGit(workspaceDir).raw(branchArgs);

        // Configure credentials
        if (githubAuthManager.authenticated) {
          githubAuthManager.configureGitCredentials(workspaceDir);
        }

        sessionManager.setBranch(appSessionId, branchPrefix);

        // Store the warm session ID on the repo.
        // Container + runner are created on-demand when the user activates
        // the session (WS connect → activateSession → getOrCreate).
        repoStore.setWarmSessionId(repoUrl, appSessionId);

        // Boot a standby container so the next activation is instant
        if (opts?.withStandby && containerManager) {
          const realCount = containerManager.size - containerManager.standbyCount;
          const maxIdle = credentialStore.getMaxIdleContainers();
          if (realCount < maxIdle) {
            const config = containerManager.buildConfig({
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
 * Wire container health monitoring — notify viewers and clean up when
 * a container dies unexpectedly (OOM, crash).
 */
export function setupContainerHealthMonitoring(
  containerManager: SessionContainerManager,
  runnerRegistry: SessionRunnerRegistry,
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void,
): void {
  containerManager.on("container_exited", (sessionId, _exitCode, error) => {
    console.error(`[container] Session ${sessionId} container exited: ${error ?? "unknown"}`);
    const runner = runnerRegistry.get(sessionId);
    if (runner) {
      runner.emitMessage({
        type: "session_status",
        sessionId,
        running: false,
        error: `Session container exited unexpectedly${error ? `: ${error}` : ""}`,
      });
      // Forced — the underlying container is gone, so the agent process is
      // already dead. We must tear down the runner to release resources.
      runner.dispose({ force: true });
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
