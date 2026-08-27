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

// ---- Re-exports for extracted modules ----
//
// All previously-exported symbols are re-exported here so existing imports
// (e.g. `from "./app-lifecycle.js"`) continue to resolve without changes.
// The implementations live in cohesive sibling modules — see each module's
// docstring for boundaries and rationale.

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

// ---- Types for lifecycle dependencies ----

/** Dependencies needed by container setup. */
export interface ContainerSetupDeps {
  deps: AppDeps;
  isTestMode: boolean;
  credentialsDir: string;
  /**
   * Orchestrator-visible state dir (the same volume `WORKSPACE_VOLUME` names).
   * Threaded into `SessionContainerManager` so the overlay dep store (docs/183)
   * can create each overlay's lower/upper/work dirs before the daemon mounts them.
   */
  stateDir?: string;
  sessionManager: SessionManager;
  /**
   * Runtime mode. When `"local"`, container construction is skipped entirely
   * (no Docker, no proxy, no health monitor). See feature 118 for the cut
   * between containerized and local modes — and the "isTestMode ≠ runtimeMode
   * === 'local'" hardening note for why these two flags must not be conflated.
   */
  runtimeMode: RuntimeMode;
  /**
   * docs/172 (planning#92) — per-session egress containment + composed allowlist
   * resolver, passed straight into the production `SessionContainerManager`.
   * Optional: a custom-injected container manager (tests) supplies its own.
   */
  resolveEgressConfig?: (sessionId: string) => ResolvedEgressConfig;
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
      stateDir: setupDeps.stateDir,
      credentialsVolume: process.env.CREDENTIALS_VOLUME,
      stackName: process.env.DOCKER_STACK,
      ...(setupDeps.resolveEgressConfig ? { resolveEgressConfig: setupDeps.resolveEgressConfig } : {}),
    });
    const dockerAvailable = await containerManager.isAvailable();
    if (dockerAvailable) {
      await containerManager.ensureNetwork();
      // docs/183 — pin the overlay dep store's runtime scope to the worker
      // image's id so a worker-image rebuild (Node/glibc bump) rotates the base
      // scope, and an ABI-incompatible base is never reused. Resolve at runtime
      // (self-updates rotate too) and publish into the orchestrator's own env —
      // the channel both `overlayRuntimeKey()` (orchestrator-side scope) and
      // `buildEnv` (forwarded into each session container's install-runtime)
      // read. Gated on the flag so a non-overlay deployment is byte-for-byte
      // unchanged; an operator-set value always wins. Runs before the disk
      // janitor's first sweep (index.ts) so the live-base scope agrees.
      if (isOverlayEnabled() && !process.env.SESSION_WORKER_IMAGE_ID) {
        const workerImageId = await containerManager.resolveWorkerImageId();
        if (workerImageId) {
          process.env.SESSION_WORKER_IMAGE_ID = workerImageId;
          console.log(`[server] Overlay runtime scope pinned to worker image ${workerImageId}`);
        }
      }
      // planning#196 — the overlay scope keys on the worker's pinned base-image digest
      // (`BASE_IMAGE_DIGEST`), not its full image id, so an app-code-only deploy
      // no longer rotates the scope (no churn, post-deploy installs stay warm).
      // Resolve it from the worker image's baked env and publish into the channel
      // both `overlayRuntimeKey()` (orchestrator scope) and `buildEnv` (forwarded
      // to the worker's install-runtime marker) read. Same gating as above: flag
      // on, operator-set value always wins. A pre-planning#196 image (no baked digest)
      // resolves to nothing → the `SESSION_WORKER_IMAGE_ID` fallback stands.
      if (isOverlayEnabled() && !process.env.BASE_IMAGE_DIGEST) {
        const baseDigest = await containerManager.resolveWorkerBaseDigest();
        if (baseDigest) {
          process.env.BASE_IMAGE_DIGEST = baseDigest;
          console.log(`[server] Overlay runtime scope pinned to base image ${baseDigest}`);
        }
      }
      // docs/248 — the overlay scope must also split when a repo's Node pin
      // moves the session off the image's Node, or a base of addons built under
      // the image's ABI would be mounted into a differently-pinned session (a
      // plain `npm install` does not rebuild an addon that is already present).
      // Resolving the image's own Node version here is what lets the scope tell
      // "this pin changes the runtime" from "this repo merely has an
      // `engines.node` field the image already satisfies" — without it, the
      // second case would rotate the scope for most of the fleet.
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
      // planning#371 — this process did not mint the decision-query tokens of the
      // sidecars that survived the previous one, and a container-facing control
      // that only works until the orchestrator restarts is the failure this area
      // has shipped before. The sidecar's own env is the source of truth
      // (`worker-auth.ts`'s precedent); this seam re-reads it on a miss.
      setEgressDecisionTokenRecovery(
        dockerEgressDecisionTokenRecovery(containerManager.getDockerClient()),
      );
      await containerManager.startHealthMonitor();
      console.log("[server] Docker container mode enabled");
    } else {
      throw new Error("Docker is not available (is /var/run/docker.sock mounted?)");
    }
  }

  // A standby container never survives the process that made it. `bootstrapManagers`
  // has already retired the warm session rows (`retireWarmSessions`), so on the
  // production path above the orphan sweep has usually removed these already —
  // this is what makes the guarantee independent of that. It runs OUTSIDE the
  // branch on purpose: an injected container manager (tests, and any future
  // caller supplying its own) skips every sweep in that branch, and "warm
  // containers die on restart" must not be a property only the production
  // wiring has. Reaping by label also catches the standby that rediscovery
  // could not adopt — no IP, no resolvable workspace — which the row-driven
  // sweeps cannot see at all.
  //
  // The session set is passed because the label is create-time and immutable: a
  // CLAIMED standby's container still carries it, and only the row says the
  // session is someone's now. Re-read here rather than reusing `activeIds`
  // above, which the injected-manager path never computes.
  if (containerManager) {
    await containerManager.reapStandbyContainers(new Set(sessionManager.allIds()));
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
  /** docs/128 — used to resolve a session's server-authoritative `kind` (ops). */
  sessionManager?: SessionManager;
  /** Runtime mode — selects ContainerSessionRunner vs in-process SessionRunner. */
  runtimeMode: RuntimeMode;
  /**
   * Optional per-session log ring writer. When provided, container
   * creation failures (which would otherwise live only in
   * `lastCreateError` until the next successful create wipes them)
   * also land in `recentLogs`, so a copied diagnostic preserves the
   * failure history.
   */
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  /**
   * OOM circuit breaker, shared with `setupContainerHealthMonitoring`.
   * When tripped for a session, container creation is refused with a
   * clear error rather than entering the destroy/recreate loop. The
   * breaker is reset by user-initiated restart endpoints — see
   * `services/recovery.ts`.
   */
  oomBreaker?: SessionOomCircuitBreaker;
  /**
   * docs/093 — durable Present-tab store. Passed into every
   * `ContainerSessionRunner` so a freshly-created runner (after a container
   * restart / idle eviction) seeds its presentation cache from persistence and
   * can re-register artifacts with the new worker to serve their bytes again.
   */
  presentStore?: PresentStore;
  /**
   * docs/280 — where an inline presentation's transcript card is persisted.
   * Passed into every `ContainerSessionRunner` because the card is emitted from
   * the present SSE stream, which the runner owns; without it an inline present
   * still reaches the Present tab and only the chat card is skipped.
   */
  chatHistoryManager?: InProgressPersister;
  /**
   * docs/150 — local mode only. The account-scoped agent factory; each
   * in-process runner gets a `createAgent` bound to it so its CLI spawns
   * against the provider account THIS session was routed to. Absent (or with
   * no `providerAccountManager`) the local runner keeps no `createAgent` and
   * callers fall through to the process-wide `agentFactory`, i.e. the
   * process-global home.
   */
  localAgentFactory?: LocalAgentFactory;
  /** docs/150 — resolves a cross-provider sub-agent spawn's account. */
  providerAccountManager?: ProviderAccountManager;
  /**
   * planning#300 — local mode only. Source of the MCP env a local spawn carries
   * (`applyLocalMcp`), standing in for the worker `PUT /secrets` push that
   * `prepareSessionAgentEnvironment` skips outside container mode. Absent ⇒ the
   * local runner spawns with no MCP at all, which is the pre-planning#300 behavior.
   */
  credentialStore?: LocalAgentMcpDeps["credentialStore"];
}

interface CreateContainerForRunnerOpts {
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
  /** docs/128 — true when the session's server-side `kind === "ops"`. Enables
   *  the privileged journal mounts + read-only Docker proxy wiring. */
  opsSession?: boolean;
  /** docs/183 / docs/211 — session identity (remote + kind + capabilities) used
   *  to resolve overlay-dep-store eligibility + specs and the sandbox Docker
   *  grant. Absent → no overlay (the unchanged path). */
  session?: Pick<SessionInfo, "remoteUrl" | "kind" | "capabilities">;
  /** Optional qualifier appended to the failure broadcast (e.g. "from standby fallback"). */
  failureContext?: string;
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  /** OOM circuit breaker — when tripped, creation is refused. */
  oomBreaker?: SessionOomCircuitBreaker;
}

/**
 * How many times {@link createContainerForRunner} tries to bring a session
 * container up before giving up.
 *
 * Container creation fails transiently more often than it fails for good: a
 * slow image pull, a busy Docker daemon, a veth/IP allocation race, a worker
 * health check that misses its window under host load. Every one of those used
 * to dispose the runner on the FIRST error, which stranded the turn the user
 * had already sent — they saw an error, typed "continue", and the fresh runner
 * (with its fresh container) then worked. The retry IS that "continue", done
 * automatically and *before* the turn is torn down, so the prompt is never
 * lost: a turn parked on the runner's worker-ready gate just starts a few
 * seconds late.
 */
const MAX_CONTAINER_CREATE_ATTEMPTS = 3;

/** Backoff before create attempt N+1. Short — a user's turn is parked on this. */
const CONTAINER_CREATE_RETRY_DELAYS_MS = [1000, 3000];

/**
 * Failures worth another attempt. Everything is retryable EXCEPT causes known
 * to be deterministic, where retrying only delays the error the user needs to
 * see: a workspace that could not be restored, and a deployment whose egress
 * sidecar image isn't configured.
 */
function isRetryableCreateFailure(errMsg: string): boolean {
  return !/Session workspace is missing|SESSION_EGRESS_SIDECAR_IMAGE is not set/i.test(errMsg);
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
 * Failures are retried up to {@link MAX_CONTAINER_CREATE_ATTEMPTS} times; only
 * when the budget is exhausted (or the cause is deterministic) is the runner
 * marked unavailable and disposed.
 *
 * The warm-pool standby creator does NOT go through this helper because
 * it produces a standby (no runner to wire) and reports failures
 * differently — it uses `mgr.createStandby` + `mgr.buildConfigForWorkspace`
 * directly.
 */
async function createContainerForRunner(opts: CreateContainerForRunnerOpts): Promise<void> {
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
    runner.markWorkerUnavailable(errMsg);
    runner.dispose({ force: true });
    return;
  }

  for (let attempt = 0; attempt < MAX_CONTAINER_CREATE_ATTEMPTS; attempt++) {
    // A retry always clears whatever the failed attempt left behind. The
    // create path's own catch removes the container and its overlay volumes,
    // but `destroy` additionally drops the manager entry and reaps
    // parent-session-labeled children, so the next attempt starts clean.
    const destroyFirst = attempt > 0 || opts.destroyExisting;
    const err = await attemptContainerCreate({ ...opts, destroyFirst });
    if (!err) return;

    const errMsg = getErrorMessage(err);
    const lastAttempt = attempt === MAX_CONTAINER_CREATE_ATTEMPTS - 1;

    // The runner went away mid-attempt (session archived, full reset, shutdown).
    // Nothing is waiting on this container any more.
    if (runner.disposed) {
      console.warn(`[container] Abandoning container creation for ${sessionId} — runner disposed: ${errMsg}`);
      return;
    }

    // A teardown for this session cancelled the create. Not a failure to
    // retry — someone asked for this container to go away, and retrying would
    // rebuild the very thing they destroyed. Terminal, so a turn parked on the
    // runner's worker-ready gate learns why instead of hanging.
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
    // Record so the health endpoint can surface it to the UI — without this
    // async creation failures from the fire-and-forget block are invisible.
    mgr.recordCreateError(sessionId, errMsg);
    // Mirror into the per-session ring — `lastCreateError` is wiped on
    // the next successful create, but a copied diagnostic still shows the
    // failure in recentLogs.
    const qualifier = opts.failureContext ? ` (${opts.failureContext})` : "";
    opts.broadcastLog?.(sessionId, "server", `Container creation failed${qualifier}: ${errMsg}`);
    // Record the cause BEFORE disposing. `dispose()` resolves the runner's
    // worker-ready gate, releasing any turn parked on it; without this the
    // released turn POSTs to the `0.0.0.0:0` placeholder and the user gets
    // `Error: connect ECONNREFUSED 0.0.0.0` instead of the real reason.
    runner.markWorkerUnavailable(errMsg);
    // Forced — container start failed, the runner is unusable and must be
    // torn down. The agent isn't running on any worker yet, but if some
    // race ever flipped `_isRunning` (early enqueue, etc.), an unforced
    // dispose would silently no-op and leak the registry entry.
    runner.dispose({ force: true });
    return;
  }
}

/**
 * One container-creation attempt. Returns the error instead of throwing so the
 * retry loop in {@link createContainerForRunner} owns all the policy (backoff,
 * terminal-failure detection, error recording) in one place.
 */
async function attemptContainerCreate(
  opts: CreateContainerForRunnerOpts & { destroyFirst: boolean },
): Promise<unknown> {
  const { mgr, runner, sessionId } = opts;
  try {
    if (opts.destroyFirst) await mgr.destroy(sessionId);
    // Snapshot the teardown counter HERE — after our own `destroyFirst` (which
    // bumps it, and must not cancel the create it exists to make room for) and
    // before the preflight awaits below. A teardown during the workspace check
    // or overlay preparation would otherwise already be counted by the time
    // `create` looks, and the create would run to completion for a session
    // that no longer exists. See `SessionContainerManager.teardownEpoch`.
    const intentEpoch = mgr.teardownEpoch(sessionId);
    // planning#181 — fail fast with a clear, terminal message if the workspace clone
    // is missing. The activation path (route-registry `activateSession`)
    // re-materializes an evicted/missing workspace from the bare cache before
    // reaching here, so this only trips when recovery was impossible (no remote,
    // bare cache also gone) or a non-activation path reached creation with a
    // reclaimed workspace. Without it the Docker bind-mount 404s with a cryptic
    // "no such file or directory" and the connect → create → 404 → dispose cycle
    // repeats; this turns it into a single greppable error the health strip shows.
    try {
      await fs.stat(opts.workspaceDir);
    } catch {
      throw new Error(
        `Session workspace is missing at ${opts.workspaceDir} — it could not be restored from the `
        + `repository (the clone may have been reclaimed and no recoverable copy remains).`,
      );
    }
    // docs/183 dep-dir design — resolve per-dep-dir overlay specs (flag-gated;
    // [] when off / ineligible / nothing overlay-worthy). The byte-for-byte
    // unchanged path returns [], so non-overlay sessions are untouched.
    const overlaySpecs = opts.session
      ? await mgr.prepareOverlaySpecs({ sessionId, workspaceDir: opts.workspaceDir, session: opts.session })
      : [];
    // docs/197 Part 2 — pnpm repos get a shared per-runtime store INSTEAD of the
    // overlay (mutually exclusive: `prepareOverlaySpecs` returns [] for them).
    // undefined when the flag is off / the session is ineligible / not a pnpm repo.
    const pnpmStoreDir = opts.session
      ? mgr.preparePnpmStore({ workspaceDir: opts.workspaceDir, session: opts.session })
      : undefined;
    // docs/211 — a sandbox's Docker access is the server-authoritative
    // `capabilities.docker` grant (its empty `/workspace` has no shipit.yaml to
    // derive it from). `undefined` for any non-sandbox session so the existing
    // shipit.yaml-derived path is byte-for-byte unchanged.
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
    // docs/279 — record the grants this container was actually plumbed with, so
    // a later edit to the durable set can be diffed against them ("pending ·
    // applies on next container start"). Recorded HERE, beside the
    // `sandboxDockerAccess` derivation above that reads the same set, because
    // this is the point the grant becomes container plumbing. Sandbox-only:
    // every other session has no capability set, and an absent record correctly
    // reads as "nothing to pend".
    //
    // Known race, accepted (review finding): `opts.session` was captured before
    // the await above, while `resolveEgressConfig` re-reads the session from
    // SQLite *during* creation. So a capability edit that lands mid-create can
    // plumb egress from the new value and record the old one. It needs the user
    // to toggle a grant in the seconds a container is booting, and the failure
    // is a pending indicator that is offered (or withheld) once too often — not
    // a wrong grant, since the durable set is what every broker reads. Recording
    // the same object Docker was derived from is the lesser evil: re-reading
    // here would make the snapshot disagree with the Docker plumbing instead,
    // which is the half that cannot be corrected without a restart anyway.
    if (opts.session?.kind === "sandbox" && opts.session.capabilities) {
      mgr.recordCapabilitiesAtStart(sessionId, opts.session.capabilities);
    }
    console.log(`[container] Container ready for ${sessionId} at ${sc.workerUrl}`);
    // The runner can be disposed during the await above, and only the FAILURE
    // path checked for it. Handing a disposed runner a worker URL opens an SSE
    // stream and starts worker resources for a session nobody owns any more.
    // The container itself needs no cleanup here: it is published in the
    // manager's map with its real id, so an archive tears it down and the idle
    // enforcer reaps it otherwise — containers deliberately outlive runners.
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
  const {
    deps, containerManager, credentialsDir, sessionManager, runtimeMode, broadcastLog,
    oomBreaker, presentStore, chatHistoryManager, localAgentFactory, providerAccountManager,
    credentialStore,
  } = factoryDeps;

  // Explicit injection always wins (tests, custom orchestrations).
  if (deps.runnerFactory) return deps.runnerFactory;

  // Local mode: in-process SessionRunner. Agent subprocesses are launched via
  // the local agent factory (claude-adapter / codex-adapter) — there is no
  // container worker to proxy to.
  //
  // docs/150 — the runner still gets a `createAgent`, not because there is
  // anything to proxy, but because it is the ONE per-session hook every spawn
  // path already prefers over the process-wide `agentFactory` (the WS handler
  // context, system turns, the rebase driver, `spawnSubAgent`). Binding the
  // session's account-scoped HOME here reaches all of them without widening a
  // single factory signature. Without a `sessionManager` there is no session to
  // resolve a route from, so we leave `createAgent` unset and behave as before.
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
          // docs/260 — env-prep stamps the turn's selected route on THIS
          // runner before the spawn resolves its HOME.
          getTurnRoute: () => runner.residentRoute,
          ...(providerAccountManager ? { providerAccountManager } : {}),
        };
        runner.createAgent = (agentId: AgentId): AgentProcess => {
          // Resolved lazily, inside the spawn: `createAgent` runs before
          // `prepareSessionAgentEnvironment` has pinned the route, and a
          // failover repoints an already-pinned session under this same runner.
          const agent = localAgentFactory(agentId, () =>
            resolveLocalAgentHome(o.sessionId, agentId, homeDeps));
          // planning#300 — and the same reasoning carries MCP. The worker performs
          // two writes before a spawn (the adapter's `writeMcpConfig`, and the
          // agent-env push that its `$secret:` resolution and the MCP children
          // read); local mode runs neither, so the CLI spawned with no MCP at
          // all. `applyLocalMcp` does both here, at the spawn, for the same
          // reason HOME is resolved here rather than provisioned per session.
          return credentialStore
            ? applyLocalMcp(agent, {
              credentialStore,
              // docs/251 — also carries this session's `/agent-ops` host address
              // into the spawn, which is what makes the `gh` shim work here.
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
      // docs/251 — close this session's `/agent-ops` host with the runner.
      // `dispose()` emits before `removeAllListeners()`, so a `once` here fires.
      //
      // Swallowing here rather than `void`-ing the promise: this runs inside
      // `disposeAll()` on the shutdown path, where anything that escapes
      // surfaces as an unhandled rejection while the process is already on its
      // way down — noise that reads like a shutdown failure and buries whatever
      // actually went wrong. A host we could not close is not worth failing a
      // shutdown over; the process is about to exit and take the socket with it.
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
        ...(presentStore ? { presentStore } : {}),
      ...(chatHistoryManager ? { chatHistoryManager } : {}),
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
        ...(presentStore ? { presentStore } : {}),
      ...(chatHistoryManager ? { chatHistoryManager } : {}),
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
          opsSession: sessionManager?.get(o.sessionId)?.kind === "ops",
          session: sessionManager?.get(o.sessionId),
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
      ...(presentStore ? { presentStore } : {}),
      ...(chatHistoryManager ? { chatHistoryManager } : {}),
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
      opsSession: sessionManager?.get(o.sessionId)?.kind === "ops",
      session: sessionManager?.get(o.sessionId),
      broadcastLog,
      oomBreaker,
    });

    return runner;
  }) : undefined;
}

// ---- Missing-container reconciler ----

/**
 * How long the worker `/events` stream must have been down before the
 * reconciler stops trusting the container map and checks reality.
 *
 * 90s is comfortably past a container restart, an orchestrator-side blip and
 * the 45s SSE idle timeout, and short enough that a genuinely dead session is
 * reported inside a couple of minutes rather than never. It does not bound a
 * slow image build: a build happens before the runner has a worker URL at all
 * (`awaitingContainer`), and a healthy worker holds its stream open regardless
 * of what its container is busy doing.
 */
export const WORKER_UNREACHABLE_MS = 90_000;

/** Timeout for the confirming worker `/health` probe. A wedged worker fails fast. */
const WORKER_PROBE_TIMEOUT_MS = 3_000;

/**
 * The container itself is gone — the ordinary case, and the one the old
 * pre-gap-E loop already handled when the map agreed.
 */
const VANISHED_NOTICE =
  "This session's container is gone — no Docker exit event was received, and Docker reports it is no longer running. "
  + "The agent's progress up to this point has been preserved. Send a message to start a fresh container.";

/**
 * The container is up but its worker never answers. Different fact, different
 * remedy: a fresh message reconnects to the SAME wedged worker, so point the
 * user at the restart action instead.
 */
const WEDGED_NOTICE =
  "This session's agent container is running but its worker has stopped responding, so the session is not live. "
  + "The agent's progress up to this point has been preserved. Restart the agent container to recover it.";

/** Does the worker answer `/health` right now? */
async function probeWorkerHealth(workerUrl: string): Promise<boolean> {
  try {
    await workerGet(workerUrl, "/health", { timeoutMs: WORKER_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Dependencies for the missing-container reconciler. */
export interface MissingContainerReconcilerDeps {
  containerManager: SessionContainerManager | null;
  runnerRegistry: SessionRunnerRegistry;
  /** Per-session log ring writer. Required — the whole point is to leave a breadcrumb. */
  broadcastLog: (sessionId: string, source: LogSource, text: string) => void;
  /**
   * Optional — when present, a runner disposed on the vanished path gets its
   * in-flight turn flushed to chat history and a visible notice appended,
   * exactly as `handleContainerExited` does for a Docker `die`. Without it
   * this path leaves nothing in the transcript and the next turn's
   * `replaceInProgress` deletes the orphaned rows.
   */
  chatHistoryManager?: ChatHistoryManager;
  /**
   * Does the worker answer right now? Defaults to a short `/health` GET.
   * Injectable so tests can exercise the live-container branch without a
   * socket, and so the probe stays a named seam rather than a hidden call.
   */
  workerResponds?: (workerUrl: string) => Promise<boolean>;
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
 * A map entry is NOT proof of life (docs/121 gap E). The map is mutated only
 * by the Docker event stream and by explicit destroys, so a `die` delivered
 * while that stream was down leaves an entry claiming `running` forever, and
 * the pre-gap-E version of this loop skipped exactly those sessions. The
 * runner's `/events` stream then reconnects on a 10s-capped backoff for the
 * life of the process while the session renders as alive and any parked turn
 * never resolves. So a runner whose stream has failed
 * {@link WORKER_UNREACHABLE_RECONNECT_ATTEMPTS} times in a row gets its
 * container checked against Docker, and a container Docker says is not
 * running is treated as the `die` we missed.
 *
 * The probe is gated on that attempt count rather than run unconditionally
 * for two reasons: it costs a Docker inspect per session per tick, and a
 * healthy session's stream never accumulates attempts at all, so the gate
 * makes a false positive structurally impossible for any session whose worker
 * is actually answering.
 *
 * Skipped runners:
 *  - Already disposed (registry lazily cleans these up).
 *  - Standby (warm-pool containers don't get registered runners until
 *    they're claimed; transient race during claim is fine — next tick).
 */
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
      // Creation in flight — NOT orphaned. `getOrCreate` registers the runner
      // synchronously and kicks `createContainerForRunner` off fire-and-forget,
      // but the manager's map entry is only written partway into
      // `createContainer`. Destroying a stale container, resolving overlay
      // specs, and building the config all happen before that, so a healthy
      // session activating right now looks container-less to this pass.
      // Force-disposing it there resolved the runner's worker-ready gate while
      // the URL was still the `0.0.0.0:0` placeholder, and the parked turn then
      // dialed it — surfacing as `Error: connect ECONNREFUSED 0.0.0.0` in chat.
      // Checked ahead of the liveness probe below so a half-created session is
      // never a candidate for it, even transiently.
      if (runner.awaitingContainer) continue;
      // Tracked container: believe it unless the runner's own transport says
      // the worker has stopped answering AND reality agrees. `containerGone`
      // also suppresses the adoption attempt below — there is nothing running
      // to adopt.
      let containerGone = false;
      let notice = VANISHED_NOTICE;
      const tracked = containerManager.get(sid);
      if (tracked) {
        const downSince = runner.workerStreamDownSince ?? 0;
        if (downSince === 0 || Date.now() - downSince < WORKER_UNREACHABLE_MS) continue;
        const downSeconds = Math.round((Date.now() - downSince) / 1000);
        // Capture the id BEFORE awaiting — `markContainerGone` refuses to act
        // on a different incarnation, so a rescue that swaps the container
        // underneath this probe cannot have its replacement deleted.
        const probedId = tracked.id;
        const alive = await containerManager.isTrackedContainerRunning(sid);
        // `undefined` = Docker could not answer. Never read that as death:
        // during a daemon outage every session would look dead at once.
        if (alive === undefined) continue;
        if (alive) {
          // The container is up but the stream is not. Requirement 6 is about
          // an unreachable WORKER, not only a missing container, so confirm
          // with a direct probe rather than assuming the container implies a
          // live worker — and rather than assuming it doesn't.
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
      // Inverse-leak backstop (C3): the runner has no container entry, but
      // a live Docker container may still exist — orphaned because a
      // `die`/`oom` event deleted a healthy container's map entry. Try to
      // re-adopt it before force-disposing; a successful adoption heals
      // the session in place instead of churning another container.
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
      // Say it where the user is actually looking. The log ring feeds the
      // diagnostics panel and `session_status.error` is not rendered at all,
      // so without this the only visible effect of this path is a spinner that
      // stops for no stated reason — and a turn that was mid-flight loses its
      // in-progress rows to the next turn's `replaceInProgress`. Runs BEFORE
      // dispose: dispose discards the turn-event buffer and tears the channel
      // down, so a notice emitted afterwards reaches nobody.
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
  defaultAgentId: AgentId;
  createRepoGit: (dir: string) => RepoGit;
  /**
   * Factory for a GitManager bound to a session's workspace dir. Passed to
   * the poller so it can override GitHub's GraphQL diff numbers — which lag
   * a few seconds after each push while GitHub reindexes — with the
   * locally-computed `git diff base...HEAD` the diff dialog also uses.
   */
  createGitManager: (dir: string) => GitManager;
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
  /**
   * docs/196 — the notify-on-merge deliverer. When present, the poller's
   * `onPrTerminalState` hook forwards every terminal PR transition (merged /
   * closed) to it; the manager no-ops unless the session carries an armed watch.
   */
  mergeWatchManager?: MergeWatchManager;
  /**
   * docs/146 — required to construct the `RebaseAndResolveCb` closure that
   * the auto-resolve manager invokes per attempt. The closure builds a
   * `RebaseDriverDeps` per-call from these shared managers + the per-session
   * runner/git, then calls `runAutoResolveAttempt`. (`createGitManager` is
   * already a required field above, used by both the diff-stats override
   * and the auto-resolve closure.)
   */
  chatHistoryManager?: ChatHistoryManager;
  usageManager?: UsageManager;
  credentialStore?: CredentialStore;
  /**
   * docs/146 — exposed for the wrapper's drain hook. When the rebase-driver's
   * resolution turn finishes, this fires to drain any user message queued
   * during the auto-resolve so it doesn't sit stranded. Optional —
   * test setups can leave it unwired.
   */
  drainQueueForSession?: (sessionId: string) => Promise<void> | void;
  /**
   * docs/146 — fallback agent factory for the resolution turn. Container
   * runners supply `createAgent` themselves; in-process runners (tests,
   * local mode) need this so `runRebaseResolutionTurn` can spawn the
   * agent. Optional — if neither is available the wrapper rejects post-
   * spawn-check, but in practice every test setup that exercises the
   * auto-path passes one.
   */
  agentFactory?: (agentId: AgentId) => AgentProcess;
}

/**
 * Create and configure the PrStatusPoller. Auto-tracks sessions with remoteUrl.
 */
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

  // docs/146 — build the `RebaseAndResolveCb` once if all the shared
  // collaborators are present; pass it into the poller constructor (it
  // forwards into the manager). The closure resolves the per-session runner
  // and git manager per-call. Skipped in degraded test setups that omit any
  // of the deps — the auto-resolve feature stays inactive.
  // The closure below runs long after this function returns, but the poller it
  // needs is constructed a few lines further down — and the poller constructor
  // is what the closure is being built for. A late-read holder breaks the cycle
  // without a forward reference to a `const` that is still in its TDZ here.
  const pollerHolder: { current: PrStatusPoller | null } = { current: null };

  let rebaseAndResolveCb: RebaseAndResolveCb | undefined;
  if (createGitManager && chatHistoryManager && usageManager) {
    rebaseAndResolveCb = async (sessionId, baseBranch): Promise<AutoResolveResult> => {
      const runner = runnerRegistry.get(sessionId);
      if (!runner) {
        // Defensive — the manager's gate already checks this, but if the
        // runner was evicted between gate and fire, treat as deferred.
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
          // planning#369 — the auto path force-pushes too, so it needs the same
          // "the conflict just cleared, go look" notification the user-driven
          // route gets. Read at call time; see `pollerHolder` above.
          prStatusPoller: pollerHolder.current,
          // Container runners supply `createAgent` themselves so this is
          // unused in production; in-process runners (tests, local mode)
          // need the fallback factory.
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
    // Lets the poller swap GitHub's GraphQL additions/deletions (which lag a
    // few seconds after each push while GitHub reindexes) for the same
    // locally-computed diff stats the click-through diff dialog uses, so the
    // card's +N/-N button can't show stale numbers.
    createGitManager,
    // docs/146 — read the global setting at decision time. When the
    // credentialStore isn't wired (minimal test setups), the manager is
    // effectively disabled.
    isAutoResolveEnabled: credentialStore ? (() => credentialStore.getAutoResolveConflicts()) : (() => false),
    // docs/169 — global gate for the auto-fix-CI loop, read at decision time.
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
    // docs/169 — the auto-fix loop's per-attempt callback. Fetches CI logs and
    // dispatches the fix as a `systemTurn` (suppressing live-steering), then
    // resolves once that turn completes so `AutoFixManager` can do its post-turn
    // re-arm accounting. Returns "noop" (don't burn budget) when there is
    // nothing to fix; "fixed" when a fix turn actually ran.
    fetchAndFixCb: async (sessionId, owner, repo, failedChecks): Promise<AutoFixResult> => {
      // This path emitted NOTHING until the check-run logs were already on their
      // way to the agent, which is why confirming the 2026-08-10 duplicate
      // dispatch from the host needed inference from turn timing rather than a
      // record of what was sent. One line per attempt, naming the exact
      // check-run ids — those ids ARE the docs/121 dedup key, so a repeat send
      // is visible by reading two log lines instead of reconstructing it.
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

      // docs/240 — await the OWNED settlement the dispatch hands back rather
      // than a hand-rolled `new Promise(resolve => onTurnComplete: resolve)`.
      // The raw callback fires only from a real turn's completion, so a turn
      // whose runner went away never resolved it and this `await` never
      // returned — leaving `AutoFixManager` parked in `running` (its only exit
      // is the post-turn write) with the arbiter claim held, which silently
      // disabled managed auto-merge and auto-resolve for the session. The
      // settlement resolves on every terminal outcome, including `dropped` when
      // the runner is disposed mid-turn.
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
      })).settled;
      const detail = outcome.detail ? ` (${outcome.detail})` : "";
      console.log(`[auto-fix] ${sessionId} ${owner}/${repo} — fix turn settled as ${outcome.status}${detail}`);
      // A turn that NEVER RAN doesn't burn budget, and only `dropped` / `steered`
      // mean that — see `autoFixResultForOutcome` for why `interrupted` is on the
      // other side of the line.
      return autoFixResultForOutcome(outcome);
    },
    // docs/194 — drive the issue-lifecycle "→ completed" transition off the
    // merged PR body. Wired only when the tracker plumbing is present (the
    // credential store + chat-history manager); degraded test setups that omit
    // either leave the feature inert. Best-effort — never throws into the poller.
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
    // docs/196 — forward every terminal PR transition (merged / closed) to the
    // notify-on-merge deliverer. It no-ops unless the session carries an armed
    // watch, so wiring it unconditionally is cheap.
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
        // docs/218 — the merge just made this session reset-eligible (mergedAt +
        // mergedHeadSha are both set now). If the user is sitting ON this session
        // and never re-activates it, neither the activation nor the post-turn
        // recompute fires, so the "start from latest base" composer control would
        // stay hidden until they switch away and back. Push the freshly-recomputed
        // signal to the attached viewers now.
        //
        // docs/266 — and when the safety gate REFUSES, write the refusal into the
        // transcript here rather than leaving it to the user's next message. A
        // hidden composer control says nothing, so the refused case used to reach
        // no user-readable surface at merge time at all. Runs whether or not a
        // runner is live: the transcript is durable, the `reset_eligible` signal
        // is not, so `sessionManager`'s workspace dir is the fallback source for
        // the session dir. Never throws — the notice is best-effort inside this
        // already-guarded block.
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
        // docs/145: a merge moved `main`, so the bare cache is now stale.
        // Refresh it off the request path so the next claim can skip its
        // synchronous fetch. Best-effort — the pre-fetcher coalesces/swallows.
        const repoUrl = sessionManager.get(sessionId)?.remoteUrl;
        if (repoUrl) onRepoMainAdvanced?.(repoUrl);
      } catch (err) {
        console.error(`[pr-poller] Post-merge handling failed for ${sessionId}:`, err);
      }

      // docs/239 — fire a SELF merge-watch here, not from `onPrTerminalState`.
      // This point is after `markMergedAndPruneExcess` has resolved, so the merge
      // bookkeeping is complete and the remote head-branch deletion has already
      // happened — a wake fired earlier could hand the agent a branch about to be
      // deleted. `setPrStatus` / `setMergedHeadSha` both ran before this callback,
      // so the deliverer reads the PR facts straight from the persisted snapshot
      // and this sessionId-only signature needs no widening. No-ops unless the
      // session carries an armed self-watch.
      //
      // Deliberately OUTSIDE the block above, not inside it: the poller's
      // `alreadyTerminal` guard means this callback fires exactly once per merge,
      // so a throw in the archive/prune step would otherwise strand the wake until
      // an orchestrator restart. Its own failures are handled internally (recorded
      // as a delivery attempt for the retry supervisor).
      if (mergeWatchManager) {
        try {
          await mergeWatchManager.handleSelfMerge(sessionId);
        } catch (err) {
          console.error(`[pr-poller] self merge-watch delivery failed for ${sessionId}:`, err);
        }
      }
    },
  });

  // Close the cycle: the auto-resolve closure reads this at call time so its
  // force-push can refresh the PR status it just changed (planning#369).
  pollerHolder.current = prStatusPoller;

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
    // Durable backlog (docs/192): survives orchestrator restart / idle eviction
    // / container destruction, unlike the in-memory ring below. The ring is
    // kept as a hot, synchronous cache for diagnostics (`getLogBuffer`).
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

// ---- Event wiring ----

/** Dependencies for event handler wiring. */
export interface EventWiringDeps {
  /**
   * Every login flow, keyed by `LoginIntegrationId`. Drives the auth wiring
   * loop — pending/complete/failed SSE rebroadcasts plus the common
   * post-completion bookkeeping (duplicate refusal, account status and
   * exhaustion, login-wide registry refresh, token re-push, agent_list
   * broadcast). Adding a new login flow is one entry here.
   * (docs/155 Phase 2 + 2b)
   */
  authManagers: Map<LoginIntegrationId, AgentAuthManager>;
  githubAuthManager: GitHubAuthManager;
  agentRegistry: AgentRegistry;
  /** Used to re-register the default provider-account row after a fresh sign-in. */
  providerAccountManager: ProviderAccountManager;
  sseBroadcast: (event: string, data: unknown) => void;
  /** Source-of-truth credentials root — used to re-push a refreshed token into pinned sessions (A3). */
  credentialsDir: string;
  /** Session metadata — used to find sessions pinned to an agent on re-auth (A3). */
  sessionManager: SessionManager;
  /**
   * docs/179 §4 — true when a CLI process is alive for this session right now.
   * The A3 re-push below still writes the rotated token when it returns true,
   * but must not rewrite credential *topology* underneath a live process.
   *
   * Optional so minimal test setups keep working; when absent the re-push
   * behaves exactly as it did before (repair always allowed), which is correct
   * for a build with no runner registry — there are no agent processes to
   * disturb.
   */
  hasLiveAgent?: (sessionId: string) => boolean;
  /**
   * docs/257 — the `agent_list` broadcasts below carry the harness-onboarding
   * stamp as well as `canRunTurns`, and `buildAgentListPayload` reads it from
   * here. Declared as `CredentialStore | undefined` rather than optional on
   * purpose: an omission must be a compiler error at the call site, not a
   * silently stamp-less payload emitted from the very handlers that make an
   * install runnable for the first time.
   */
  credentialStore: CredentialStore | undefined;
  /** Drop state owned by the credential that a scoped sign-in replaced. */
  onCredentialReplaced?: (agentId: AgentId, accountId: string) => void;
}

/**
 * Refresh every harness affected by a credential change that a HARNESS noticed.
 *
 * The background refreshers are per-CLI, so they hold an `AgentId` — but the
 * account status they flip belongs to the shared route, so the refresh has to
 * widen to the login's whole harness set. Falls back to the single harness when
 * the service declares no login flow, which keeps a key-only service working.
 */
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
  /** docs/257 — see {@link EventWiringDeps.credentialStore}. */
  credentialStore: CredentialStore | undefined;
}): void {
  const { agentId, accountId, providerAccountManager, agentRegistry, sseBroadcast, credentialStore } = opts;
  try {
    providerAccountManager.setAccountStatus(accountServiceForHarness(agentId), accountId, "auth_failed");
  } catch (err) {
    console.error(`[auth] failed to mark account ${accountId} auth_failed:`, err);
  }
  // Fan out. `agentId` names the harness whose refresher rotated the token, but
  // what changed is the SHARED account route's status — so eligibility must be
  // recomputed for every harness that login serves, not just the one that
  // noticed. (Cross-backend review of the login re-key.)
  refreshAuthForAccountHarness(agentRegistry, agentId);
  sseBroadcast("provider_accounts", { accounts: providerAccountManager.list() });
  sseBroadcast("agent_list", buildAgentListPayload(agentRegistry, credentialStore, providerAccountManager));
}

/**
 * Recovery counterpart to {@link markProviderAccountUnauthenticated}. When the
 * OAuth refresher rotates a previously-revoked account's token back to a
 * healthy state, the account is genuinely usable again — flip its persisted
 * status back to `ready`, recompute the agent's cached `hasRunnableModels`, and
 * re-broadcast so the model selector clears its stale "needs auth" state.
 *
 * Without this, an account that was marked `auth_failed` (by the refresher's
 * revoked classification — sometimes a transient/misclassified failure) stays
 * stuck `auth_failed` forever: the refresher's own success path only cleared an
 * in-memory flag and emitted an unconsumed SSE, so the agent kept working
 * (its on-disk token is valid and re-pushed to sessions) while the picker kept
 * showing "needs auth" and refused model changes.
 *
 * Idempotent: a no-op when the account is already `ready`, so the refresher can
 * signal recovery without forcing a redundant `agent_list` broadcast on every
 * routine healthy rotation.
 */
export function markProviderAccountReauthenticated(opts: {
  agentId: AgentId;
  accountId: string;
  providerAccountManager: ProviderAccountManager;
  agentRegistry: AgentRegistry;
  sseBroadcast: (event: string, data: unknown) => void;
  /** docs/257 — see {@link EventWiringDeps.credentialStore}. */
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
  // Fan out. `agentId` names the harness whose refresher rotated the token, but
  // what changed is the SHARED account route's status — so eligibility must be
  // recomputed for every harness that login serves, not just the one that
  // noticed. (Cross-backend review of the login re-key.)
  refreshAuthForAccountHarness(agentRegistry, agentId);
  sseBroadcast("provider_accounts", { accounts: providerAccountManager.list() });
  sseBroadcast("agent_list", buildAgentListPayload(agentRegistry, credentialStore, providerAccountManager));
}

/** Wire auth event handlers. */
export function wireEventHandlers(eventDeps: EventWiringDeps): void {
  const { authManagers, githubAuthManager, agentRegistry, providerAccountManager, sseBroadcast, credentialsDir, sessionManager, hasLiveAgent, credentialStore } = eventDeps;

  /**
   * A3 (docs/142): after a Claude/Codex re-auth, force the fresh source token
   * into every session already pinned to that agent. Without this a session
   * pinned before the re-login keeps its stale per-session token until its next
   * turn's sync-in — so an idle pinned session would stay 401'd even though the
   * user just re-authed. Best-effort and self-limiting: `repushAgentToken` only
   * overwrites sessions that already hold the agent's token (no cross-agent
   * leak, no-op in local mode where there are no per-session dirs).
   *
   * `accountId` is required, and that is load-bearing rather than tidiness: an
   * unscoped call skipped the marker check below AND fell to the flat repush
   * for every session, so it copied `<credentialsRoot>/.claude/…` — a root that
   * nothing account-scoped ever refreshes — over the per-session copy of every
   * pinned session, including sessions whose marker names some other account.
   * That both undid the scoped push that had just delivered the fresh token and
   * left sessions running on a foreign, ageing bearer. The only caller that
   * could reach it was the duplicate `complete` fixed in the Claude auth
   * manager; making the parameter required is what stops a future one.
   */
  const repushTokenToPinnedSessions = (agentId: AgentId, accountId: string): void => {
    let healed = 0;
    for (const session of sessionManager.list()) {
      if (!session.agentPinned || session.agentId !== agentId) continue;
      // docs/260 — whose token a session's subtree holds is the subtree's own
      // recorded identity (the account marker), never a session row. A pre-260
      // subtree with no marker keeps the legacy flat repush below, which only
      // overwrites a token file the session already has.
      const marked = readSessionAccountMarker(credentialsDir, session.id)[agentId];
      if (marked !== undefined && marked !== accountId) continue;
      try {
        // docs/179 §4 — a sign-in can complete at any moment, including while
        // a streaming CLI is resident. Deliver the fresh token, but leave
        // credential topology alone under a live process: the leak repair's
        // unlink→copy window makes that process report itself unauthenticated.
        const opts = { repairLeakedSubtrees: !hasLiveAgent?.(session.id) };
        // An UNMARKED subtree's identity is unknown — it may hold a different
        // account's copy, and a marker only appears when account provisioning
        // writes one. Pushing the re-authed account's token there would poison
        // a session that is spending another account (the 2026-08-10 incident
        // class), so an unmarked session only ever gets the legacy flat repush,
        // which overwrites nothing but a flat token file it already has. Its
        // next turn's env-prep provisions and marks it properly.
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

  // The agent-list snapshot used to be hand-rolled here. It is
  // `buildAgentListPayload` now — docs/257 needs `canRunTurns` on every
  // producer of the event, and the hand-rolled copy had already drifted
  // (`reasoning` and `supportsCompaction` were missing from it).

  // docs/144 — sign-out sweep. When an agent's auth drops to not-configured,
  // wipe any in-flight cross-agent credential subtree provisioned for a spawn
  // from sessions where this agent is NOT the pinned agent, so a sub-agent's
  // creds never outlive the user's authorization. Guarded so minimal test
  // stubs (which don't extend EventEmitter) can omit the subscription.
  if (typeof agentRegistry.on === "function") {
    agentRegistry.on("sign-out", (agentId: AgentId) => {
      sweepSubAgentCredentialsOnSignOut(agentId, { sessionManager, credentialsDir });
    });
  }

  // ---- Per-agent auth wiring (docs/155 Phase 2 + 2b) ----
  // One subscription set per backend, keyed off the auth-manager map. The
  // SSE events are unified into the `agent_auth_*` family — payload shape
  // differences (Claude's paste-code URL vs Codex's device URL + user code)
  // live in the discriminated `details` field on `agent_auth_pending`, so
  // adding a new backend doesn't add a third event triplet. The legacy
  // per-agent events (`auth_url`, `codex_auth_pending`, …) keep firing on
  // the concrete classes for back-compat with the unit tests and any
  // remaining direct listeners, but no SSE wiring depends on them.
  for (const [loginId, mgr] of authManagers) {
    // Three different questions, three different keys — see `AgentAuthManager`.
    const serviceId = serviceForLoginIntegration(loginId);
    // The CLI that runs this flow and owns the credential files it writes.
    const credentialHarness = credentialHarnessForLogin(loginId);
    mgr.on("progress", (payload: AgentAuthProgressPayload) => {
      sseBroadcast("agent_auth_progress", payload);
    });

    mgr.on("log", (payload: AgentAuthLogPayload) => {
      sseBroadcast("agent_auth_log", payload);
    });

    mgr.on("pending", (details: AgentAuthPendingDetails) => {
      // docs/150 — qualify the broadcast with the account being authenticated
      // (read synchronously here, while the flow is still active) so the
      // matching Settings row surfaces the pending URL/code.
      const accountId = mgr.getActiveAccountId() ?? undefined;
      sseBroadcast("agent_auth_pending", { loginId, ...(accountId ? { accountId } : {}), details });
    });

    mgr.on("complete", () => {
      // docs/150-multiple-provider-subscriptions req 19 — every flow is account-scoped (`start` requires the
      // scope), so a completion always names its account. The old `else` here
      // re-ran `migrateDefaultAccounts()` to re-register a default row after a
      // singleton sign-in; there is no singleton sign-in any more, and a user
      // signing in after a sign-out goes through "Add account", which creates
      // the row before the flow starts. A null here would mean a manager
      // emitted `complete` without a start, which is a bug worth seeing rather
      // than papering over with a migration.
      const accountId = mgr.getActiveAccountId() ?? undefined;
      if (accountId) {
        // docs/150-multiple-provider-subscriptions req 22 — the CLI has written credentials; find out WHOSE
        // before anything treats the row as connected. A refusal must happen
        // here rather than on the next turn: once the row goes `ready` it is
        // selectable, and a duplicate account is worst precisely when it gets
        // picked as a failover target for the account it duplicates.
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
        // Invalidate the old credential's bench and quota state before the
        // stable account row becomes selectable again. This ordering is
        // load-bearing: `ready` with a stale exhaustion stamp can make routing
        // report that every account is exhausted after a healthy re-login.
        try {
          providerAccountManager.clearAccountExhaustion(serviceId!, accountId);
          if (credentialHarness) eventDeps.onCredentialReplaced?.(credentialHarness, accountId);
          providerAccountManager.setAccountStatus(serviceId!, accountId, "ready");
        } catch (err) {
          console.error(`[auth] failed to mark account ${accountId} ready:`, err);
          return;
        }
      } else {
        // Nothing here is safe to act on: with no account we cannot say whose
        // credentials just landed, so marking a row ready and pushing tokens
        // are both guesses. The re-push in particular is destructive — see
        // `repushTokenToPinnedSessions` — so an unscoped completion stays a
        // logged anomaly and touches no session's credentials.
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
        // docs/150 — record the scoped failure on the row so Settings shows
        // "auth failed" instead of a stuck "authenticating" spinner.
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
