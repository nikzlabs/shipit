import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import {
  credentialHarnessForLogin,
  loginIntegrationForService,
  nativeServiceForHarness,
  serviceForLoginIntegration,
} from "../shared/catalogue/index.js";
import path from "node:path";
import fs from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import { SessionContainerManager, resolveAgentDockerLimits } from "./session-container.js";
import { ContainerCreateCancelledError } from "./container-lifecycle.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import type { PresentStore } from "./present-store.js";
import type { InProgressPersister } from "./chat-card-persistence.js";
import type { SessionRunnerFactory, SessionRunnerRegistry } from "./session-runner.js";
import { cleanupOrphanComposeResources } from "./container-discovery.js";
import { preservePartialTurnOnWorkerLoss } from "./startup-tasks.js";
import { workerGet } from "./worker-http.js";
import { isOverlayEnabled } from "./overlay-session.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { createDockerProxy, resolveOwnContainerIp } from "./docker-proxy.js";
import type { SessionInfo as DockerProxySessionInfo } from "./docker-proxy.js";
import type { SessionInfo } from "../shared/types.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import type { MergeWatchManager } from "./merge-watch.js";
import { applyMergedPrIssueRefs, type MergedPrInfo } from "./issue-lifecycle.js";
import { getErrorMessage } from "./validation.js";
import type { LogStore } from "./log-store.js";
import { fetchCIFailureLogs, buildCIFixPrompt } from "./services/github.js";
import { markMergedAndPruneExcess } from "./services/session.js";
import { announceResetStateOnMerge } from "./services/pre-turn-reset.js";
import { runAutoResolveAttempt } from "./services/rebase-driver.js";
import type { AutoResolveResult, RebaseAndResolveCb } from "./auto-conflict-resolve-manager.js";
import { autoFixResultForOutcome, type AutoFixResult } from "./auto-fix-manager.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { UsageManager } from "./usage.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionManager } from "./sessions.js";
import { repushAgentToken, repushProviderAccountToken,
  readSessionAccountMarker,
} from "./session-credentials.js";
import type { RepoGit } from "./repo-git.js";
import type { GitManager } from "../shared/git.js";
import type { AgentAuthManager, AgentAuthFailedPayload } from "./agent-auth-manager.js";
import type { AgentAuthPendingDetails } from "../shared/types/ws-server-messages.js";
import type {
  AgentAuthLogPayload,
  AgentAuthProgressPayload,
} from "./agents/claude/auth-diagnostics.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import { accountServiceForHarness } from "./provider-account-manager.js";
import type { LocalAgentFactory } from "./local-agent-home.js";
import { resolveLocalAgentHome } from "./local-agent-home.js";
import type { LocalAgentMcpDeps } from "./local-agent-mcp.js";
import { applyLocalMcp } from "./local-agent-mcp.js";
import { stopLocalAgentOpsHost } from "./local-agent-ops.js";
import { refuseIfAlreadyConnected } from "./provider-account-identity.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type { AgentId, AgentProcess, LogSource, LogRingEntry } from "../shared/types.js";
import type { AppDeps, RuntimeMode } from "./app-di.js";
import { SessionRunner } from "./session-runner.js";
import { prepareDispatch } from "./prepared-dispatch.js";
import { buildAgentListPayload } from "./services/settings.js";
import { sweepSubAgentCredentialsOnSignOut } from "./services/sub-agent.js";
import { setEgressDecisionTokenRecovery } from "./egress-decision-auth.js";
import { dockerEgressDecisionTokenRecovery } from "./egress-proxy-install.js";

export { createIdleEnforcer } from "./idle-enforcer.js";
export type { IdleEnforcementDeps, IdleServiceHooks } from "./idle-enforcer.js";

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
  bareCacheRoot,
  depCacheRoot,
} from "./session-dir-factory.js";
export type { SessionDirDeps } from "./session-dir-factory.js";

export { createWarmPool } from "./warm-pool-manager.js";
export type { WarmPoolDeps } from "./warm-pool-manager.js";

export {
  createWarmPreviewStarter,
  preStartWarmPreview,
  isRecentlyUsedRepo,
  WARM_PREVIEW_RECENCY_DAYS,
} from "./warm-preview.js";
export type { WarmPreviewDeps } from "./warm-preview.js";

export {
  runRepoMigration,
  runRemoteCredentialScrub,
  runMcpOAuthStartupRefresh,
  retireWarmSessions,
  scheduleStartupTasks,
  handleContainerExited,
  setupContainerHealthMonitoring,
} from "./startup-tasks.js";
export type { StartupDeps } from "./startup-tasks.js";

export { registerShutdownHook } from "./shutdown-manager.js";
export type { ShutdownDeps } from "./shutdown-manager.js";

export interface ContainerSetupDeps {
  deps: AppDeps;
  isTestMode: boolean;
  credentialsDir: string;
  /** Orchestrator path to the volume named by WORKSPACE_VOLUME. */
  stateDir?: string;
  sessionManager: SessionManager;
  runtimeMode: RuntimeMode;
  resolveEgressConfig?: (sessionId: string) => ResolvedEgressConfig;
}

export interface ContainerSetupResult {
  containerManager: SessionContainerManager | null;
  dockerProxyServer: HttpServer | null;
}

export async function setupContainerManager(
  setupDeps: ContainerSetupDeps,
): Promise<ContainerSetupResult> {
  const { deps, isTestMode, credentialsDir: _credentialsDir, sessionManager, runtimeMode } = setupDeps;

  if (runtimeMode === "local") {
    console.log("[server] Runtime mode: local — skipping Docker container setup");
    return { containerManager: null, dockerProxyServer: null };
  }

  let containerManager: SessionContainerManager | null = null;
  if (deps.sessionContainerManager) {
    containerManager = deps.sessionContainerManager;
  } else if (!isTestMode && !deps.runnerFactory) {
    containerManager = new SessionContainerManager({
      workspaceVolume: process.env.WORKSPACE_VOLUME,
      stateDir: setupDeps.stateDir,
      credentialsVolume: process.env.CREDENTIALS_VOLUME,
      stackName: process.env.DOCKER_STACK,
      ...(setupDeps.resolveEgressConfig ? { resolveEgressConfig: setupDeps.resolveEgressConfig } : {}),
    });
    const dockerAvailable = await containerManager.isAvailable();
    if (dockerAvailable) {
      await containerManager.ensureNetwork();
      if (isOverlayEnabled() && !process.env.SESSION_WORKER_IMAGE_ID) {
        const workerImageId = await containerManager.resolveWorkerImageId();
        if (workerImageId) {
          process.env.SESSION_WORKER_IMAGE_ID = workerImageId;
          console.log(`[server] Overlay runtime scope pinned to worker image ${workerImageId}`);
        }
      }
      // Base digest keeps overlays reusable across app-only image changes.
      if (isOverlayEnabled() && !process.env.BASE_IMAGE_DIGEST) {
        const baseDigest = await containerManager.resolveWorkerBaseDigest();
        if (baseDigest) {
          process.env.BASE_IMAGE_DIGEST = baseDigest;
          console.log(`[server] Overlay runtime scope pinned to base image ${baseDigest}`);
        }
      }
      // Separate native-addon overlays when a repository changes the Node ABI.
      if (isOverlayEnabled() && !process.env.WORKER_IMAGE_NODE_VERSION) {
        const nodeVersion = await containerManager.resolveWorkerNodeVersion();
        if (nodeVersion) {
          process.env.WORKER_IMAGE_NODE_VERSION = nodeVersion;
          console.log(`[server] Worker image runs Node ${nodeVersion}`);
        }
      }
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
      // Recover tokens from sidecars that survived the orchestrator restart.
      setEgressDecisionTokenRecovery(
        dockerEgressDecisionTokenRecovery(containerManager.getDockerClient()),
      );
      await containerManager.startHealthMonitor();
      console.log("[server] Docker container mode enabled");
    } else {
      throw new Error("Docker is not available (is /var/run/docker.sock mounted?)");
    }
  }

  // Include injected managers. Claimed standbys retain their label, so check live session IDs.
  if (containerManager) {
    const liveIds = new Set(sessionManager.allIds());
    await containerManager.reapStandbyContainers(liveIds);
    // Compose previews carry parent-session labels, not the standby label.
    const docker = containerManager.getDockerClient?.();
    if (docker) await cleanupOrphanComposeResources(docker, liveIds);
  }

  let dockerProxyServer: HttpServer | null = null;
  if (containerManager && !isTestMode) {
    try {
      const proxyAdvertiseIp = await resolveOwnContainerIp(process.env.DOCKER_NETWORK);
      const proxy = createDockerProxy({
        getSessionByContainerIp: (ip: string): DockerProxySessionInfo | undefined => {
          const sc = containerManager.getSessionByContainerIp(ip);
          if (!sc) return undefined;
          return {
            sessionId: sc.sessionId,
            hostWorkspaceDir: sc.hostWorkspaceDir,
            dockerAccess: sc.dockerAccess,
            sessionNetworkName: sc.sessionNetworkName,
            resourceLimits: sc.resourceLimits,
          };
        },
        onTopologyChange: () => containerManager.beginContainerTopologyChange(),
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
          resolve();
        });
      });
      dockerProxyServer = proxy;
    } catch (err) {
      console.warn(`[server] Docker API proxy setup skipped: ${(err as Error).message}`);
    }
  }

  return { containerManager, dockerProxyServer };
}

export interface RunnerFactoryDeps {
  deps: AppDeps;
  containerManager: SessionContainerManager | null;
  credentialsDir: string;
  sessionManager?: SessionManager;
  runtimeMode: RuntimeMode;
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  oomBreaker?: SessionOomCircuitBreaker;
  presentStore?: PresentStore;
  chatHistoryManager?: InProgressPersister;
  localAgentFactory?: LocalAgentFactory;
  providerAccountManager?: ProviderAccountManager;
  credentialStore?: LocalAgentMcpDeps["credentialStore"];
}

interface CreateContainerForRunnerOpts {
  mgr: SessionContainerManager;
  runner: ContainerSessionRunner;
  sessionId: string;
  /** Parent of workspaceDir. */
  sessionDir: string;
  workspaceDir: string;
  credentialsDir: string;
  depCacheDir?: string;
  destroyExisting: boolean;
  opsSession?: boolean;
  session?: Pick<SessionInfo, "remoteUrl" | "kind" | "capabilities">;
  failureContext?: string;
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  oomBreaker?: SessionOomCircuitBreaker;
}

const MAX_CONTAINER_CREATE_ATTEMPTS = 3;

const CONTAINER_CREATE_RETRY_DELAYS_MS = [1000, 3000];

function isRetryableCreateFailure(errMsg: string): boolean {
  return !/Session workspace is missing|SESSION_EGRESS_SIDECAR_IMAGE is not set/i.test(errMsg);
}

async function createContainerForRunner(opts: CreateContainerForRunnerOpts): Promise<void> {
  const { mgr, runner, sessionId } = opts;

  if (opts.oomBreaker?.isTripped(sessionId)) {
    const errMsg = `Session disabled — agent container OOM-killed too many times. Increase \`agent.memory\` in shipit.yaml and use "Rescue session" to retry.`;
    console.warn(`[container] Refusing to create container for ${sessionId}: OOM circuit breaker tripped`);
    mgr.recordCreateError(sessionId, errMsg);
    opts.broadcastLog?.(sessionId, "server", errMsg);
    runner.markWorkerUnavailable(errMsg);
    runner.dispose({ force: true });
    return;
  }

  for (let attempt = 0; attempt < MAX_CONTAINER_CREATE_ATTEMPTS; attempt++) {
    const destroyFirst = attempt > 0 || opts.destroyExisting;
    const err = await attemptContainerCreate({ ...opts, destroyFirst });
    if (!err) return;

    const errMsg = getErrorMessage(err);
    const lastAttempt = attempt === MAX_CONTAINER_CREATE_ATTEMPTS - 1;

    if (runner.disposed) {
      console.warn(`[container] Abandoning container creation for ${sessionId} — runner disposed: ${errMsg}`);
      return;
    }

    // Retrying would undo the requested teardown.
    if (err instanceof ContainerCreateCancelledError) {
      console.warn(`[container] Container creation for ${sessionId} cancelled by a concurrent teardown — not retrying.`);
      mgr.recordCreateError(sessionId, errMsg);
      runner.markWorkerUnavailable(errMsg);
      runner.dispose({ force: true });
      return;
    }

    if (!lastAttempt && isRetryableCreateFailure(errMsg)) {
      const delayMs = CONTAINER_CREATE_RETRY_DELAYS_MS[attempt] ?? 3000;
      console.warn(
        `[container] Container creation for ${sessionId} failed (attempt ${attempt + 1}/${MAX_CONTAINER_CREATE_ATTEMPTS}), `
        + `retrying in ${delayMs}ms: ${errMsg}`,
      );
      opts.broadcastLog?.(
        sessionId,
        "server",
        `Container creation failed (attempt ${attempt + 1}/${MAX_CONTAINER_CREATE_ATTEMPTS}) — retrying: ${errMsg}`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    console.error(`[container] Failed to start container for ${sessionId}:`, errMsg);
    mgr.recordCreateError(sessionId, errMsg);
    const qualifier = opts.failureContext ? ` (${opts.failureContext})` : "";
    opts.broadcastLog?.(sessionId, "server", `Container creation failed${qualifier}: ${errMsg}`);
    // Dispose releases waiting turns; record the error before they can use the placeholder URL.
    runner.markWorkerUnavailable(errMsg);
    runner.dispose({ force: true });
    return;
  }
}

async function attemptContainerCreate(
  opts: CreateContainerForRunnerOpts & { destroyFirst: boolean },
): Promise<unknown> {
  const { mgr, runner, sessionId } = opts;
  try {
    if (opts.destroyFirst) await mgr.destroy(sessionId, { replacementFollows: true });
    // Exclude our own teardown, but detect cancellations during preflight awaits.
    const intentEpoch = mgr.teardownEpoch(sessionId);
    try {
      await fs.stat(opts.workspaceDir);
    } catch {
      throw new Error(
        `Session workspace is missing at ${opts.workspaceDir} — it could not be restored from the `
        + `repository (the clone may have been reclaimed and no recoverable copy remains).`,
      );
    }
    const overlaySpecs = opts.session
      ? await mgr.prepareOverlaySpecs({ sessionId, workspaceDir: opts.workspaceDir, session: opts.session })
      : [];
    const pnpmStoreDir = opts.session
      ? mgr.preparePnpmStore({ workspaceDir: opts.workspaceDir, session: opts.session })
      : undefined;
    const sandboxDockerAccess = opts.session?.kind === "sandbox"
      ? !!opts.session.capabilities?.docker
      : undefined;
    const config = mgr.buildConfigForWorkspace({
      sessionId,
      sessionDir: opts.sessionDir,
      workspaceDir: opts.workspaceDir,
      credentialsDir: opts.credentialsDir,
      depCacheDir: opts.depCacheDir,
      pnpmStoreDir,
      opsSession: opts.opsSession,
      ...(sandboxDockerAccess !== undefined ? { dockerAccess: sandboxDockerAccess } : {}),
      overlaySpecs,
    });
    const createStart = Date.now();
    const sc = await mgr.create(config, { intentEpoch });
    console.log(`[timing] container.create for ${sessionId} took ${Date.now() - createStart}ms`);
    // Keep the Docker grant snapshot. Egress may read newer grants during create.
    if (opts.session?.kind === "sandbox" && opts.session.capabilities) {
      mgr.recordCapabilitiesAtStart(sessionId, opts.session.capabilities);
    }
    console.log(`[container] Container ready for ${sessionId} at ${sc.workerUrl}`);
    // Containers can outlive runners; do not reopen a disposed runner's SSE stream.
    if (runner.disposed) {
      console.warn(
        `[container] Container for ${sessionId} came up after its runner was disposed — `
        + "not wiring it to the runner.",
      );
      mgr.clearCreateError(sessionId);
      return null;
    }
    runner.setWorkerUrl(sc.workerUrl);
    mgr.clearCreateError(sessionId);
    return null;
  } catch (err) {
    return err ?? new Error("Container creation failed");
  }
}

export function buildRunnerFactory(
  factoryDeps: RunnerFactoryDeps,
): SessionRunnerFactory | undefined {
  const {
    deps, containerManager, credentialsDir, sessionManager, runtimeMode, broadcastLog,
    oomBreaker, presentStore, chatHistoryManager, localAgentFactory, providerAccountManager,
    credentialStore,
  } = factoryDeps;

  if (deps.runnerFactory) return deps.runnerFactory;

  if (runtimeMode === "local") {
    return (o: Parameters<SessionRunnerFactory>[0]) => {
      const runner = new SessionRunner({
        sessionId: o.sessionId,
        sessionDir: o.sessionDir,
        defaultAgentId: o.defaultAgentId,
      });
      if (localAgentFactory && sessionManager) {
        const homeDeps = {
          sessionManager,
          credentialsDir,
          getTurnRoute: () => runner.residentRoute,
          ...(providerAccountManager ? { providerAccountManager } : {}),
        };
        runner.createAgent = (agentId: AgentId): AgentProcess => {
          // Resolve HOME at spawn: environment preparation and failover can change the route.
          const agent = localAgentFactory(agentId, () =>
            resolveLocalAgentHome(o.sessionId, agentId, homeDeps));
          return credentialStore
            ? applyLocalMcp(agent, {
              credentialStore,
              sessionId: o.sessionId,
              onServerFailed: (name, reason) => {
                runner.emitMessage({
                  type: "mcp_server_status",
                  sessionId: o.sessionId,
                  name,
                  state: "failed",
                  reason,
                });
              },
            })
            : agent;
        };
      }
      runner.once("disposed", () => {
        stopLocalAgentOpsHost(o.sessionId).catch((err: unknown) => {
          console.warn(
            `[local-agent-ops] ${o.sessionId} teardown failed: ${getErrorMessage(err)}`,
          );
        });
      });
      return runner;
    };
  }

  return containerManager ? ((o: Parameters<SessionRunnerFactory>[0]) => {
    const mgr = containerManager;
    // The factory receives the workspace path as sessionDir.
    const parentSessionDir = path.dirname(o.sessionDir);
    const acquireStart = Date.now();

    const existing = mgr.get(o.sessionId);

    if (existing?.status === "running") {
      const standby = mgr.isStandby(o.sessionId);
      mgr.claimStandby(o.sessionId);
      console.log(
        `[timing] container.acquire for ${o.sessionId} ` +
          `path=${standby ? "standby-hit" : "reconnect"} took=${Date.now() - acquireStart}ms`,
      );
      console.log(`[container] Reconnecting to existing container for ${o.sessionId} at ${existing.workerUrl}`);
      return new ContainerSessionRunner({
        sessionId: o.sessionId,
        sessionDir: o.sessionDir,
        defaultAgentId: o.defaultAgentId,
        workerUrl: existing.workerUrl,
        ...(presentStore ? { presentStore } : {}),
      ...(chatHistoryManager ? { chatHistoryManager } : {}),
      });
    }

    if (existing?.status === "starting") {
      console.log(`[container] Waiting for in-progress container creation for ${o.sessionId}...`);
      const runner = new ContainerSessionRunner({
        sessionId: o.sessionId,
        sessionDir: o.sessionDir,
        defaultAgentId: o.defaultAgentId,
        workerUrl: "http://0.0.0.0:0",
        ...(presentStore ? { presentStore } : {}),
      ...(chatHistoryManager ? { chatHistoryManager } : {}),
      });

      void (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const sc = mgr.get(o.sessionId);
          if (sc?.status === "running") {
            mgr.claimStandby(o.sessionId);
            console.log(
              `[timing] container.acquire for ${o.sessionId} path=standby-wait ` +
                `took=${Date.now() - acquireStart}ms`,
            );
            console.log(`[container] Standby container ready for ${o.sessionId} at ${sc.workerUrl}`);
            runner.setWorkerUrl(sc.workerUrl);
            mgr.clearCreateError(o.sessionId);
            return;
          }
          if (!sc) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        console.log(
          `[timing] container.acquire for ${o.sessionId} path=standby-abandoned ` +
            `took=${Date.now() - acquireStart}ms (a cold create follows, timed separately)`,
        );
        console.log(`[container] Standby not ready, creating fresh container for ${o.sessionId}...`);
        await createContainerForRunner({
          mgr, runner,
          sessionId: o.sessionId,
          sessionDir: parentSessionDir,
          workspaceDir: o.sessionDir,
          credentialsDir,
          depCacheDir: o.depCacheDir,
          destroyExisting: false,
          opsSession: sessionManager?.get(o.sessionId)?.kind === "ops",
          session: sessionManager?.get(o.sessionId),
          failureContext: "from standby fallback",
          broadcastLog,
          oomBreaker,
        });
      })();

      return runner;
    }

    const runner = new ContainerSessionRunner({
      sessionId: o.sessionId,
      sessionDir: o.sessionDir,
      defaultAgentId: o.defaultAgentId,
      workerUrl: "http://0.0.0.0:0",
      ...(presentStore ? { presentStore } : {}),
      ...(chatHistoryManager ? { chatHistoryManager } : {}),
    });
    console.log(`[container] ${existing ? "Replacing stale" : "Creating"} container for session ${o.sessionId}...`);
    console.log(
      `[timing] container.acquire for ${o.sessionId} path=cold took=${Date.now() - acquireStart}ms ` +
        `(the create it starts is timed separately)`,
    );
    void createContainerForRunner({
      mgr, runner,
      sessionId: o.sessionId,
      sessionDir: parentSessionDir,
      workspaceDir: o.sessionDir,
      credentialsDir,
      depCacheDir: o.depCacheDir,
      destroyExisting: !!existing,
      opsSession: sessionManager?.get(o.sessionId)?.kind === "ops",
      session: sessionManager?.get(o.sessionId),
      broadcastLog,
      oomBreaker,
    });

    return runner;
  }) : undefined;
}

export const WORKER_UNREACHABLE_MS = 90_000;

const WORKER_PROBE_TIMEOUT_MS = 3_000;

const VANISHED_NOTICE =
  "This session's container is gone — no Docker exit event was received, and Docker reports it is no longer running. "
  + "The agent's progress up to this point has been preserved. Send a message to start a fresh container.";

const WEDGED_NOTICE =
  "This session's agent container is running but its worker has stopped responding, so the session is not live. "
  + "The agent's progress up to this point has been preserved. Restart the agent container to recover it.";

async function probeWorkerHealth(workerUrl: string): Promise<boolean> {
  try {
    await workerGet(workerUrl, "/health", { timeoutMs: WORKER_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

export interface MissingContainerReconcilerDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  broadcastLog: (sessionId: string, source: LogSource, text: string) => void;
  chatHistoryManager?: ChatHistoryManager;
  workerResponds?: (workerUrl: string) => Promise<boolean>;
  sessionInfoResolver?: (sessionId: string) => {
    workspaceDir: string;
    dockerAccess: boolean;
    resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
  } | undefined;
}

/** Recover missed Docker exit events; a tracked container may no longer be alive. */
export function createMissingContainerReconciler(
  deps: MissingContainerReconcilerDeps,
): () => Promise<void> {
  const {
    containerManager, runnerRegistry, broadcastLog, sessionInfoResolver, chatHistoryManager,
    workerResponds = probeWorkerHealth,
  } = deps;
  return async () => {
    if (!containerManager) return;
    for (const sid of runnerRegistry.ids()) {
      const runner = runnerRegistry.get(sid);
      if (!runner) continue;
      if (containerManager.isStandby(sid)) continue;
      // Runners register before container creation adds the manager entry.
      if (runner.awaitingContainer) continue;
      let containerGone = false;
      let notice = VANISHED_NOTICE;
      const tracked = containerManager.get(sid);
      if (tracked) {
        const downSince = runner.workerStreamDownSince ?? 0;
        if (downSince === 0 || Date.now() - downSince < WORKER_UNREACHABLE_MS) continue;
        const downSeconds = Math.round((Date.now() - downSince) / 1000);
        // Capture the ID before awaiting so this probe cannot delete a replacement.
        const probedId = tracked.id;
        const alive = await containerManager.isTrackedContainerRunning(sid);
        // A Docker outage is not proof that a container died.
        if (alive === undefined) continue;
        if (alive) {
          if (await workerResponds(tracked.workerUrl)) continue;
          console.error(
            `[orphan-runner] Session ${sid} worker has not answered for ${downSeconds}s (container still running) — reporting it unreachable`,
          );
          notice = WEDGED_NOTICE;
        } else {
          console.error(
            `[orphan-runner] Session ${sid} worker unreachable for ${downSeconds}s and Docker reports its container not running — applying the missed exit`,
          );
          if (!await containerManager.markContainerGone(sid, probedId)) continue;
          containerGone = true;
        }
      }
      if (sessionInfoResolver && !containerGone && !tracked) {
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
        `[orphan-runner] Session ${sid} has runner but no reachable worker — force-disposing`,
      );
      broadcastLog(sid, "server", notice);
      // Persist before dispose discards the turn buffer and closes the channel.
      if (chatHistoryManager) {
        preservePartialTurnOnWorkerLoss(sid, runner, chatHistoryManager, notice);
      }
      runner.emitMessage({
        type: "session_status",
        sessionId: sid,
        running: false,
        error: notice,
      });
      runner.dispose({ force: true });
    }
  };
}

export interface SSEClient { write: (data: string) => boolean; closed: boolean }

export function createSSE(): {
  sseClients: Set<SSEClient>;
  sseBroadcast: (event: string, data: unknown) => void;
} {
  const sseClients = new Set<SSEClient>();

  const sseBroadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      if (!client.closed) client.write(payload);
    }
  };

  return { sseClients, sseBroadcast };
}

export interface PrPollerDeps {
  deps: AppDeps;
  githubAuthManager: GitHubAuthManager;
  sessionManager: SessionManager;
  sseBroadcast: (event: string, data: unknown) => void;
  runnerRegistry: SessionRunnerRegistry;
  defaultAgentId: AgentId;
  createRepoGit: (dir: string) => RepoGit;
  createGitManager: (dir: string) => GitManager;
  getBareCacheDir: (repoUrl: string) => string;
  pruneSessionVolumes?: (sessionId: string) => Promise<void>;
  onRepoMainAdvanced?: (repoUrl: string) => void;
  containerManager?: SessionContainerManager | null;
  mergeWatchManager?: MergeWatchManager;
  chatHistoryManager?: ChatHistoryManager;
  usageManager?: UsageManager;
  credentialStore?: CredentialStore;
  drainQueueForSession?: (sessionId: string) => Promise<void> | void;
  agentFactory?: (agentId: AgentId) => AgentProcess;
}

export function createPrStatusPoller(
  pollerDeps: PrPollerDeps,
): PrStatusPoller {
  const {
    deps, githubAuthManager, sessionManager, sseBroadcast,
    runnerRegistry, defaultAgentId, createRepoGit, getBareCacheDir, pruneSessionVolumes,
    onRepoMainAdvanced, containerManager, mergeWatchManager,
    createGitManager, chatHistoryManager, usageManager, credentialStore,
    drainQueueForSession, agentFactory,
  } = pollerDeps;

  // The constructor needs a callback that later reads the constructed poller.
  const pollerHolder: { current: PrStatusPoller | null } = { current: null };

  let rebaseAndResolveCb: RebaseAndResolveCb | undefined;
  if (createGitManager && chatHistoryManager && usageManager) {
    rebaseAndResolveCb = async (sessionId, baseBranch): Promise<AutoResolveResult> => {
      const runner = runnerRegistry.get(sessionId);
      if (!runner) {
        return { outcome: "deferred", lastError: "no_runner", didWork: false };
      }
      const git = createGitManager(runner.sessionDir);
      return await runAutoResolveAttempt(
        {
          git,
          githubAuthManager,
          runner,
          sessionManager,
          chatHistoryManager,
          usageManager,
          sseBroadcast,
          prStatusPoller: pollerHolder.current,
          ...(agentFactory ? { agentFactory } : {}),
          ...(drainQueueForSession ? { drainQueue: () => drainQueueForSession(sessionId) } : {}),
        },
        baseBranch,
      );
    };
  }

  const prStatusPoller = deps.prStatusPoller ?? new PrStatusPoller({
    githubAuth: githubAuthManager,
    sessionManager,
    sseBroadcast,
    runnerRegistry,
    getSharedRepoDir: getBareCacheDir,
    createGitManager,
    isAutoResolveEnabled: credentialStore ? (() => credentialStore.getAutoResolveConflicts()) : (() => false),
    isAutoFixEnabled: credentialStore ? (() => credentialStore.getAutoFixCi()) : (() => false),
    ensureRunner: async (sessionId) => {
      const session = sessionManager.get(sessionId);
      if (!session?.workspaceDir) return undefined;
      return runnerRegistry.getOrCreate(
        sessionId,
        session.workspaceDir,
        session.agentId ?? defaultAgentId,
      );
    },
    ...(rebaseAndResolveCb ? { rebaseAndResolveCb } : {}),
    fetchAndFixCb: async (sessionId, owner, repo, failedChecks): Promise<AutoFixResult> => {
      const checkLabel = failedChecks.map((c) => `${c.name}#${c.databaseId}`).join(", ") || "(none)";
      const noop = (lastError: string): AutoFixResult => {
        console.log(`[auto-fix] ${sessionId} ${owner}/${repo} — no attempt sent (${lastError}); checks: ${checkLabel}`);
        return { outcome: "noop", lastError };
      };
      const runner = runnerRegistry.get(sessionId);
      if (!runner) return noop("no_runner");
      if (failedChecks.length === 0) return noop("no_failed_checks");

      const logs = await fetchCIFailureLogs(githubAuthManager, owner, repo, failedChecks, runner.sessionDir);
      if (logs.length === 0) return noop("no_logs");
      const prompt = buildCIFixPrompt(logs);
      console.log(`[auto-fix] ${sessionId} ${owner}/${repo} — dispatching a fix turn for ${checkLabel}`);

      // Settlement also resolves on disposal; onTurnComplete alone can wait forever.
      const outcome = await runner.dispatch(prepareDispatch({
        text: prompt,
        agentInterface: undefined,
        activity: "Auto-fixing CI...",
        systemTurn: true,
        onTurnComplete: undefined,
        execution: undefined,
        images: undefined,
        files: undefined,
        uploads: undefined,
        permissionMode: undefined,
        postTurn: undefined,
        deliveryId: undefined,
        dictated: undefined,
        resetMergedBranch: undefined,
        compactContext: undefined,
        silent: undefined,
      })).settled;
      const detail = outcome.detail ? ` (${outcome.detail})` : "";
      console.log(`[auto-fix] ${sessionId} ${owner}/${repo} — fix turn settled as ${outcome.status}${detail}`);
      return autoFixResultForOutcome(outcome);
    },
    ...(credentialStore && chatHistoryManager
      ? {
          onMergedPr: (info: MergedPrInfo) =>
            applyMergedPrIssueRefs(
              {
                credentialStore,
                ...(deps.trackerFetchImpl ? { trackerFetchImpl: deps.trackerFetchImpl } : {}),
                githubAuthManager,
                sessionManager,
                chatHistoryManager,
                runnerRegistry,
              },
              info,
            ),
        }
      : {}),
    ...(mergeWatchManager
      ? { onPrTerminalState: (info) => mergeWatchManager.handleChildPrTerminal(info) }
      : {}),
    onMergeDetectedCb: async (sessionId) => {
      try {
        const result = await markMergedAndPruneExcess(
          sessionManager, runnerRegistry, getBareCacheDir, sessionId,
          pruneSessionVolumes, createRepoGit, githubAuthManager, containerManager,
        );
        sseBroadcast("session_list", { sessions: result.sessions });
        console.log(`[pr-poller] Post-merge: marked ${sessionId} as merged`);
        const mergedRunner = runnerRegistry.get(sessionId);
        const mergedSessionDir = mergedRunner?.sessionDir ?? sessionManager.get(sessionId)?.workspaceDir;
        if (mergedSessionDir) {
          await announceResetStateOnMerge(
            {
              getSession: (id) => sessionManager.get(id),
              getPrStatus: (id) => sessionManager.getPrStatus(id),
              createGitManager,
              chatHistory: chatHistoryManager,
            },
            { sessionId, sessionDir: mergedSessionDir, runner: mergedRunner ?? null },
          );
        }
        const repoUrl = sessionManager.get(sessionId)?.remoteUrl;
        if (repoUrl) onRepoMainAdvanced?.(repoUrl);
      } catch (err) {
        console.error(`[pr-poller] Post-merge handling failed for ${sessionId}:`, err);
      }

      // Wake after branch cleanup, even if cleanup failed: this callback fires once per merge.
      if (mergeWatchManager) {
        try {
          await mergeWatchManager.handleSelfMerge(sessionId);
        } catch (err) {
          console.error(`[pr-poller] self merge-watch delivery failed for ${sessionId}:`, err);
        }
      }
    },
  });

  pollerHolder.current = prStatusPoller;

  // Load before tracking so active sessions retain their snapshot until the first poll.
  prStatusPoller.loadPersisted();

  for (const session of sessionManager.list()) {
    if (session.remoteUrl) {
      prStatusPoller.trackSession(session.id, session.remoteUrl);
    }
  }

  return prStatusPoller;
}

const MAX_LOG_ENTRIES = 500;

export function createLogBuffer(logStore?: LogStore): {
  getLogBuffer: (sessionId: string) => LogRingEntry[];
  clearLogBuffer: (sessionId: string) => void;
  removeLogBuffer: (sessionId: string) => void;
  broadcastLog: (sessionId: string, source: LogSource, text: string) => void;
} {
  const buffers = new Map<string, LogRingEntry[]>();

  const broadcastLog = (
    sessionId: string,
    source: LogSource,
    text: string,
  ) => {
    const entry: LogRingEntry = {
      source,
      text,
      timestamp: new Date().toISOString(),
    };
    logStore?.appendEntry(sessionId, "agent", { ts: entry.timestamp, source, text });
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
    clearLogBuffer: (sessionId: string) => {
      buffers.set(sessionId, []);
      logStore?.clearSync(sessionId, "agent");
    },
    removeLogBuffer: (sessionId: string) => { buffers.delete(sessionId); },
    broadcastLog,
  };
}

export interface EventWiringDeps {
  authManagers: Map<LoginIntegrationId, AgentAuthManager>;
  githubAuthManager: GitHubAuthManager;
  agentRegistry: AgentRegistry;
  providerAccountManager: ProviderAccountManager;
  sseBroadcast: (event: string, data: unknown) => void;
  credentialsDir: string;
  sessionManager: SessionManager;
  hasLiveAgent?: (sessionId: string) => boolean;
  credentialStore: CredentialStore | undefined;
  onCredentialReplaced?: (agentId: AgentId, accountId: string) => void;
}

// One account can serve several harnesses.
function refreshAuthForAccountHarness(agentRegistry: AgentRegistry, agentId: AgentId): void {
  const loginId = loginIntegrationForService(nativeServiceForHarness(agentId));
  if (loginId) agentRegistry.refreshAuthForLogin(loginId);
  else agentRegistry.refreshAuth(agentId);
}

export function markProviderAccountUnauthenticated(opts: {
  agentId: AgentId;
  accountId: string;
  providerAccountManager: ProviderAccountManager;
  agentRegistry: AgentRegistry;
  sseBroadcast: (event: string, data: unknown) => void;
  credentialStore: CredentialStore | undefined;
}): void {
  const { agentId, accountId, providerAccountManager, agentRegistry, sseBroadcast, credentialStore } = opts;
  try {
    providerAccountManager.setAccountStatus(accountServiceForHarness(agentId), accountId, "auth_failed");
  } catch (err) {
    console.error(`[auth] failed to mark account ${accountId} auth_failed:`, err);
  }
  refreshAuthForAccountHarness(agentRegistry, agentId);
  sseBroadcast("provider_accounts", { accounts: providerAccountManager.list() });
  sseBroadcast("agent_list", buildAgentListPayload(agentRegistry, credentialStore, providerAccountManager));
}

export function markProviderAccountReauthenticated(opts: {
  agentId: AgentId;
  accountId: string;
  providerAccountManager: ProviderAccountManager;
  agentRegistry: AgentRegistry;
  sseBroadcast: (event: string, data: unknown) => void;
  credentialStore: CredentialStore | undefined;
}): void {
  const { agentId, accountId, providerAccountManager, agentRegistry, sseBroadcast, credentialStore } = opts;
  const current = providerAccountManager.get(accountServiceForHarness(agentId), accountId);
  if (!current || current.status === "ready") return;
  try {
    providerAccountManager.setAccountStatus(accountServiceForHarness(agentId), accountId, "ready");
  } catch (err) {
    console.error(`[auth] failed to mark account ${accountId} ready:`, err);
    return;
  }
  refreshAuthForAccountHarness(agentRegistry, agentId);
  sseBroadcast("provider_accounts", { accounts: providerAccountManager.list() });
  sseBroadcast("agent_list", buildAgentListPayload(agentRegistry, credentialStore, providerAccountManager));
}

export function wireEventHandlers(eventDeps: EventWiringDeps): void {
  const { authManagers, githubAuthManager, agentRegistry, providerAccountManager, sseBroadcast, credentialsDir, sessionManager, hasLiveAgent, credentialStore } = eventDeps;

  const repushTokenToPinnedSessions = (agentId: AgentId, accountId: string): void => {
    let healed = 0;
    for (const session of sessionManager.list()) {
      if (!session.agentPinned || session.agentId !== agentId) continue;
      // The subtree marker identifies its account; the session row may have changed.
      const marked = readSessionAccountMarker(credentialsDir, session.id)[agentId];
      if (marked !== undefined && marked !== accountId) continue;
      try {
        // Unlinking credentials during repair would interrupt a live CLI.
        const opts = { repairLeakedSubtrees: !hasLiveAgent?.(session.id) };
        // An unmarked subtree may belong to another account; update only its existing flat token.
        const wrote = marked !== undefined
          ? repushProviderAccountToken(credentialsDir, session.id, agentId, accountId, undefined, undefined, opts)
          : repushAgentToken(credentialsDir, session.id, agentId, undefined, undefined, opts);
        if (wrote) healed++;
      } catch (err) {
        console.error(`[auth] A3 token re-push failed for session ${session.id}:`, err);
      }
    }
    if (healed > 0) console.log(`[auth] re-pushed refreshed ${agentId} token into ${healed} pinned session(s)`);
  };

  if (typeof agentRegistry.on === "function") {
    agentRegistry.on("sign-out", (agentId: AgentId) => {
      sweepSubAgentCredentialsOnSignOut(agentId, { sessionManager, credentialsDir });
    });
  }

  for (const [loginId, mgr] of authManagers) {
    const serviceId = serviceForLoginIntegration(loginId);
    const credentialHarness = credentialHarnessForLogin(loginId);
    mgr.on("progress", (payload: AgentAuthProgressPayload) => {
      sseBroadcast("agent_auth_progress", payload);
    });

    mgr.on("log", (payload: AgentAuthLogPayload) => {
      sseBroadcast("agent_auth_log", payload);
    });

    mgr.on("pending", (details: AgentAuthPendingDetails) => {
      const accountId = mgr.getActiveAccountId() ?? undefined;
      sseBroadcast("agent_auth_pending", { loginId, ...(accountId ? { accountId } : {}), details });
    });

    mgr.on("complete", () => {
      const accountId = mgr.getActiveAccountId() ?? undefined;
      if (accountId) {
        // Reject duplicates before routing can select the account.
        const refusal = credentialHarness
          ? refuseIfAlreadyConnected(credentialHarness, accountId, providerAccountManager)
          : null;
        if (refusal) {
          agentRegistry.refreshAuthForLogin(loginId);
          sseBroadcast("agent_auth_failed", {
            loginId,
            accountId,
            reason: "duplicate",
            message: refusal,
          });
          sseBroadcast("agent_list", buildAgentListPayload(agentRegistry, credentialStore, providerAccountManager));
          sseBroadcast("provider_accounts", { accounts: providerAccountManager.list() });
          return;
        }
        // Clear old exhaustion state before the account becomes selectable.
        try {
          providerAccountManager.clearAccountExhaustion(serviceId!, accountId);
          if (credentialHarness) eventDeps.onCredentialReplaced?.(credentialHarness, accountId);
          providerAccountManager.setAccountStatus(serviceId!, accountId, "ready");
        } catch (err) {
          console.error(`[auth] failed to mark account ${accountId} ready:`, err);
          return;
        }
      } else {
        console.warn(`[auth] ${loginId} reported a completed sign-in with no account scope; nothing to mark ready, and no token re-push`);
      }
      agentRegistry.refreshAuthForLogin(loginId);
      if (credentialHarness && accountId) repushTokenToPinnedSessions(credentialHarness, accountId);
      sseBroadcast("agent_auth_complete", { loginId, ...(accountId ? { accountId } : {}) });
      sseBroadcast("agent_list", buildAgentListPayload(agentRegistry, credentialStore, providerAccountManager));
      sseBroadcast("provider_accounts", { accounts: providerAccountManager.list() });
    });

    mgr.on("failed", (payload?: AgentAuthFailedPayload) => {
      const accountId = mgr.getActiveAccountId() ?? undefined;
      console.log(`[${loginId}] flow failed:`, payload?.reason ?? "", payload?.message ?? "");
      if (accountId) {
        try {
          providerAccountManager.setAccountStatus(serviceId!, accountId, "auth_failed");
        } catch (err) {
          console.error(`[auth] failed to mark account ${accountId} auth_failed:`, err);
        }
        sseBroadcast("provider_accounts", { accounts: providerAccountManager.list() });
      }
      sseBroadcast("agent_auth_failed", {
        loginId,
        ...(accountId ? { accountId } : {}),
        ...(payload?.reason ? { reason: payload.reason } : {}),
        ...(payload?.message ? { message: payload.message } : {}),
      });
      agentRegistry.refreshAuthForLogin(loginId);
      sseBroadcast("agent_list", buildAgentListPayload(agentRegistry, credentialStore, providerAccountManager));
    });
  }

  githubAuthManager.on("token_invalid", (ev: { reason: string }) => {
    sseBroadcast("github_status", {
      authenticated: false,
      tokenInvalidReason: ev.reason,
    });
  });
}

export function resolveAutoStartDeps(env: NodeJS.ProcessEnv = process.env): AppDeps {
  const localStateDir = env.RUNTIME_MODE === "local"
    ? env.SHIPIT_STATE_DIR
    : undefined;
  return {
    serveStatic: true,
    ...(localStateDir ? { credentialsDir: path.join(localStateDir, "credentials") } : {}),
  };
}

export async function autoStart(buildApp: (deps: AppDeps) => Promise<FastifyInstance>): Promise<void> {
  const app = await buildApp(resolveAutoStartDeps());

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // One rejected worker request must not stop every session.
  process.on("unhandledRejection", (reason: unknown) => {
    console.error("[orchestrator] unhandled promise rejection (kept process alive):", reason);
  });

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`[server] listening on http://0.0.0.0:${port}`);
}
