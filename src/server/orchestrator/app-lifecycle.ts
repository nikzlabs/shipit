import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import type { GitManager } from "../shared/git.js";
import simpleGit from "simple-git";
import { generateBranchPrefix, repoUrlToHash, pushToOrigin } from "./git-utils.js";
import { SessionContainerManager } from "./session-container.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import type { SessionRunnerFactory, SessionRunnerInterface } from "./session-runner.js";
import { SessionRunnerRegistry } from "./session-runner.js";
import { resolveSessionConfig } from "../shared/session-config.js";
import { createDockerProxy, resolveOwnContainerIp } from "./docker-proxy.js";
import type { SessionInfo as DockerProxySessionInfo } from "./docker-proxy.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import { getErrorMessage } from "./validation.js";
import { fetchCIFailureLogs, buildCIFixPrompt } from "./services/github.js";
import { deleteSession, markMergedAndPruneExcess } from "./services/session.js";
import { ServiceManager } from "./service-manager.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { RepoGit } from "./repo-git.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { UsageManager } from "./usage.js";
import type { AuthManager } from "./auth.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { CredentialStore } from "./credential-store.js";
import type { DatabaseManager } from "../shared/database.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { AgentId, AgentProcess, WsLogEntry } from "../shared/types.js";
import type { AppDeps } from "./app-di.js";

// ---- Types for lifecycle dependencies ----

/** Dependencies needed by container setup. */
export interface ContainerSetupDeps {
  deps: AppDeps;
  isTestMode: boolean;
  credentialsDir: string;
  sessionManager: SessionManager;
}

/** Result of container setup. */
export interface ContainerSetupResult {
  containerManager: SessionContainerManager | null;
  dockerProxyServer: HttpServer | null;
}

/**
 * Initialize Docker container manager and Docker API proxy.
 * In test mode or when a custom runner factory is provided, returns nulls.
 */
export async function setupContainerManager(
  setupDeps: ContainerSetupDeps,
): Promise<ContainerSetupResult> {
  const { deps, isTestMode, credentialsDir: _credentialsDir, sessionManager } = setupDeps;

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
}

/**
 * Build the effective SessionRunnerFactory. In production with Docker,
 * creates ContainerSessionRunner instances. Tests inject a custom factory.
 */
export function buildRunnerFactory(
  factoryDeps: RunnerFactoryDeps,
): SessionRunnerFactory | undefined {
  const { deps, containerManager, credentialsDir } = factoryDeps;

  return deps.runnerFactory ?? (containerManager ? ((o: Parameters<SessionRunnerFactory>[0]) => {
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
        } catch (err) {
          console.error(`[container] Failed to start container for ${o.sessionId}:`, getErrorMessage(err));
          runner.dispose();
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
      } catch (err) {
        console.error(`[container] Failed to start container for ${o.sessionId}:`, getErrorMessage(err));
        runner.dispose();
      }
    })();

    return runner;
  }) : undefined);
}

// ---- Idle container enforcement ----

/** Dependencies for idle container enforcement. */
export interface IdleEnforcementDeps {
  containerManager: SessionContainerManager | null;
  credentialStore: CredentialStore;
  runnerRegistry: SessionRunnerRegistry;
}

/**
 * Create the `enforceIdleContainerLimit` function. When more containers are
 * idle than the configured limit, stop the oldest excess containers and
 * dispose their runners.
 */
export function createIdleEnforcer(
  enforceDeps: IdleEnforcementDeps,
): () => void {
  const { containerManager, credentialStore, runnerRegistry } = enforceDeps;

  return () => {
    if (!containerManager) return;
    const maxIdle = credentialStore.getMaxIdleContainers();
    const idleSessionIds: string[] = [];

    for (const sc of containerManager.getAll()) {
      if (containerManager.isStandby(sc.sessionId)) continue;
      const runner = runnerRegistry.get(sc.sessionId);
      if (!runner || (runner.viewerCount === 0 && !runner.running)) {
        idleSessionIds.push(sc.sessionId);
      }
    }

    if (idleSessionIds.length > maxIdle) {
      // Map insertion order = oldest first; slice from the front to keep the newest.
      const excess = idleSessionIds.slice(0, idleSessionIds.length - maxIdle);
      for (const sid of excess) {
        console.log(`[idle-cleanup] Stopping idle container for session ${sid}`);
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
  /** Container manager for connecting agent containers to compose networks. */
  containerManager: SessionContainerManager | null;
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
    getDepCacheDir, serviceManagers, composeWarnings, containerManager,
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
              console.error("[system-turn] auto-push failed:", getErrorMessage(err));
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

      // Set up compose ServiceManager if the session has a compose config
      setupServiceManager(runner, {
        sessionManager, serviceManagers, composeWarnings, containerManager,
      });
    },
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
    containerManager: SessionContainerManager | null;
  },
): void {
  const { sessionManager, serviceManagers, composeWarnings, containerManager } = deps;
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
  // the WS listener is not yet connected so emitMessage would be lost.
  if (shipitConfig.warnings.length > 0) {
    const text = `shipit.yaml needs migration:\n${shipitConfig.warnings.map(w => `• ${w}`).join("\n")}`;
    composeWarnings.set(runner.sessionId, text);
    runner.on("disposed", () => composeWarnings.delete(runner.sessionId));
  }

  if (!shipitConfig.compose) return;

  // Workspace volume info for compose volume rewriting: user `.:/workspace`
  // bind mounts must map to the same storage as the agent container.
  const wsVolume = process.env.WORKSPACE_VOLUME;
  const wsSubpath = wsVolume ? workspaceDir.replace(/^\/workspace\//, "") : undefined;

  const mgr = new ServiceManager({
    sessionId: runner.sessionId,
    workspaceDir,
    composeConfig: shipitConfig.compose,
    workspaceVolume: wsVolume,
    workspaceSubpath: wsSubpath,
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

  // Wire ServiceManager to runner for event relay to WS clients
  if (runner.setServiceManager) {
    runner.setServiceManager(mgr);
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
    runnerRegistry, createRepoGit, getBareCacheDir,
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
          sessionManager, runnerRegistry, createRepoGit, getBareCacheDir, sessionId,
        );
        sseBroadcast("session_list", { sessions: result.sessions });
        console.log(`[pr-poller] Post-merge: marked ${sessionId} as merged`);
      } catch (err) {
        console.error(`[pr-poller] Post-merge handling failed for ${sessionId}:`, err);
      }
    },
  });

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

/** Create the log buffer and broadcast helper. */
export function createLogBuffer(): {
  getLogBuffer: () => WsLogEntry[];
  clearLogBuffer: () => void;
  broadcastLog: (source: WsLogEntry["source"], text: string) => void;
} {
  let logBuffer: WsLogEntry[] = [];

  const broadcastLog = (source: WsLogEntry["source"], text: string) => {
    const entry: WsLogEntry = {
      type: "log_entry",
      source,
      text,
      timestamp: new Date().toISOString(),
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
      logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
    }
  };

  return {
    getLogBuffer: () => logBuffer,
    clearLogBuffer: () => { logBuffer = []; },
    broadcastLog,
  };
}

// ---- Event wiring ----

/** Dependencies for event handler wiring. */
export interface EventWiringDeps {
  authManager: AuthManager;
  agentRegistry: AgentRegistry;
  defaultAgentId: AgentId;
  broadcastLog: (source: WsLogEntry["source"], text: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;
}

/** Wire auth event handlers. */
export function wireEventHandlers(eventDeps: EventWiringDeps): void {
  const { authManager, agentRegistry, defaultAgentId, sseBroadcast } = eventDeps;

  // ---- Auth event handlers ----
  authManager.on("auth_url", (url: string) => {
    sseBroadcast("auth_required", { url });
  });

  authManager.on("auth_complete", () => {
    agentRegistry.refreshAuth("claude");
    const agents = agentRegistry.list().map((a) => ({
      id: a.id, name: a.name, installed: a.installed,
      authConfigured: a.authConfigured, models: a.capabilities.models,
    }));
    sseBroadcast("auth_complete", {});
    sseBroadcast("agent_list", { agents, defaultAgentId });
  });

  authManager.on("auth_failed", () => {
    console.log("[auth] OAuth flow failed — client should provide API key");
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

/** Create the `getBareCacheDir` helper — returns the bare repo cache path. */
export function createBareCacheDirHelper(
  workspaceDir: string,
): (repoUrl: string) => string {
  const cacheRoot = path.join(workspaceDir, "repo-cache");
  return (repoUrl: string): string => {
    return path.join(cacheRoot, repoUrlToHash(repoUrl));
  };
}

/**
 * Create the `getDepCacheDir` helper — returns a per-repo dependency cache
 * directory decoupled from the bare cache. Lives at /workspace/dep-cache/{hash}.
 */
export function createDepCacheDirHelper(
  workspaceDir: string,
): (repoUrl: string) => string {
  const depCacheRoot = path.join(workspaceDir, "dep-cache");
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
      runner.dispose();
    }
  });
}

// ---- Graceful shutdown ----

/** Dependencies for shutdown hook. */
export interface ShutdownDeps {
  startupTimer: ReturnType<typeof setTimeout>;
  authManager: AuthManager;
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
