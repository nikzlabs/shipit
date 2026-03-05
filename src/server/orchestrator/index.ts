import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { GitManager } from "../shared/git.js";
import { AgentRegistry, ALLOWED_ENV_KEYS } from "../shared/agent-registry.js";
import { RepoGit } from "./repo-git.js";
import { AuthManager } from "./auth.js";
import { GitHubAuthManager } from "./github-auth.js";
import { SessionManager } from "./sessions.js";
import { RepoStore } from "./repo-store.js";
import { generateBranchPrefix, repoUrlToHash, pushToOrigin } from "./git-utils.js";
import { ChatHistoryManager } from "./chat-history.js";
import { UsageManager } from "./usage.js";
import { FeatureManager } from "./features.js";
import { DeploymentManager } from "./deployment-manager.js";
import { DeploymentStore } from "./deployment-store.js";
import { CredentialStore } from "./credential-store.js";
import { initGlobalGitConfig, getGitIdentity } from "./git-config.js";
import { VercelTarget } from "./deploy-targets/vercel.js";
import { CloudflareTarget } from "./deploy-targets/cloudflare.js";
import { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { SessionContainerManager } from "./session-container.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { registerPreviewProxy } from "./preview-proxy.js";
import { PrStatusPoller } from "./pr-status-poller.js";
import { resolveSessionConfig } from "../shared/session-config.js";
import { createDockerProxy, resolveBridgeGatewayIp } from "./docker-proxy.js";
import type { SessionInfo as DockerProxySessionInfo } from "./docker-proxy.js";
import type { AgentId, AgentEvent, AgentProcess } from "../shared/types.js";
import type { WsClientMessage, WsServerMessage, WsLogEntry } from "../shared/types.js";
import { getErrorMessage } from "./validation.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./ws-handlers/types.js";
import * as terminalHandlers from "./ws-handlers/terminal-handlers.js";
import * as miscHandlers from "./ws-handlers/misc-handlers.js";
import * as deployHandlers from "./ws-handlers/deploy-handlers.js";
import * as rollbackHandlers from "./ws-handlers/rollback-handlers.js";
import * as sendMessageHandlers from "./ws-handlers/send-message.js";
import { registerApiRoutes } from "./api-routes.js";
import { fetchCIFailureLogs, buildCIFixPrompt } from "./services/github.js";
import { archiveSession } from "./services/session.js";
export { CONTEXT_WINDOW_TOKENS } from "./ws-handlers/send-message.js";

const WORKSPACE = "/workspace";

/**
 * Dependencies that can be injected for testing. Every field is optional —
 * production uses real implementations, tests can supply mocks/stubs.
 */
export interface AppDeps {
  /**
   * Factory for creating per-session GitManager instances. Each session gets
   * its own git repo; this factory creates a GitManager for a given directory.
   * Defaults to `(dir) => new GitManager(dir)`.
   */
  createGitManager?: (workspaceDir: string) => GitManager;
  /**
   * Factory for creating RepoGit instances (shared-repo and worktree ops).
   * Defaults to `(dir) => new RepoGit(dir)`.
   */
  createRepoGit?: (repoDir: string) => RepoGit;
  /** Session manager instance. Defaults to `new SessionManager()`. */
  sessionManager?: SessionManager;
  /** Auth manager instance. Defaults to `new AuthManager()`. */
  authManager?: AuthManager;
  /** GitHub auth manager instance. Defaults to `new GitHubAuthManager()`. */
  githubAuthManager?: GitHubAuthManager;
  /** Chat history manager instance. Defaults to `new ChatHistoryManager()`. */
  chatHistoryManager?: ChatHistoryManager;
  /** Usage/cost tracking manager instance. Defaults to `new UsageManager()`. */
  usageManager?: UsageManager;
  /**
   * Factory for creating AgentProcess instances by agent ID.
   * Required for integration tests (inject FakeClaudeProcess / FakeCodexProcess).
   * In production, agent processes live inside session containers — the
   * orchestrator never spawns agents directly.
   */
  agentFactory?: (agentId: AgentId) => AgentProcess;
  /** Default agent ID for new sessions. Defaults to "claude". */
  defaultAgentId?: AgentId;
  /** Root workspace directory. Defaults to `/workspace`. */
  workspaceDir?: string;
  /** Directory for persistent credentials (survives full reset). Defaults to `/credentials`. */
  credentialsDir?: string;
  /** Whether to serve static files from dist/client. Defaults to true. */
  serveStatic?: boolean;
  /**
   * Deployment manager instance. Defaults to a new manager with Vercel and
   * Cloudflare targets registered.
   */
  deploymentManager?: DeploymentManager;
  /**
   * Deployment store instance. Defaults to `new DeploymentStore(workspaceDir)`.
   */
  deploymentStore?: DeploymentStore;
  /**
   * Feature manager instance. Defaults to `new FeatureManager(workspaceDir)`.
   * Scans docs/ for feature directories and parses status from frontmatter.
   */
  featureManager?: FeatureManager;
  /**
   * Text generation function for AI-powered features (e.g., PR description).
   * Spawns a short-lived Claude process, collects text output, and returns it.
   * Inject a stub in tests.
   */
  generateText?: (prompt: string, cwd?: string) => Promise<string>;
  /**
   * Unified credential store for git identity, GitHub token, agent API keys.
   * Defaults to `new CredentialStore(credentialsDir)`.
   */
  credentialStore?: CredentialStore;
  /**
   * Debounce delay in milliseconds for auto-push after commit.
   * Defaults to 5000 (5 seconds). Set lower in tests to avoid long waits.
   */
  autoPushDebounceMs?: number;
  /**
   * Agent registry instance. Defaults to a new `AgentRegistry()` with
   * auto-detection at startup.
   */
  agentRegistry?: AgentRegistry;
  /**
   * Custom runner factory for the session runner registry. When provided,
   * the registry uses this to create runners instead of the default.
   * Used to inject ContainerSessionRunner for Docker mode.
   */
  runnerFactory?: import("./session-runner.js").SessionRunnerFactory;
  /**
   * Pre-configured SessionContainerManager instance. When provided, skips
   * Docker auto-detection and network setup. Useful for testing.
   */
  sessionContainerManager?: import("./session-container.js").SessionContainerManager;
  /** Repo store instance. Defaults to `new RepoStore()`. */
  repoStore?: RepoStore;
  /**
   * Pre-configured PrStatusPoller instance. When provided, the internally created
   * one is replaced. Useful for testing auto-fix flows.
   */
  prStatusPoller?: PrStatusPoller;
}

/**
 * Build and configure the Fastify app with all routes and WebSocket handlers.
 * Returns the app instance without starting it — call `app.listen()` separately.
 *
 * This separation enables integration testing: tests can call `buildApp({ ... })`
 * with mock dependencies, then use `app.inject()` or connect WebSocket clients
 * to the app without spawning real child processes.
 */
export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const {
    defaultAgentId = "claude" as AgentId,
    workspaceDir = WORKSPACE,
    credentialsDir = "/credentials",
    serveStatic: shouldServeStatic = true,
    autoPushDebounceMs = 5000,
  } = deps;

  // Agent factory — only available in tests (injected via deps.agentFactory).
  // In production, agent processes live inside session containers; the
  // orchestrator never spawns agents directly. The ctx.agentFactory delegates
  // to runner.createAgent() which creates a proxy to the container worker.
  const agentFactory: ((agentId: AgentId) => AgentProcess) | undefined = deps.agentFactory;

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  // ---- Per-session directory root ----
  const sessionsRoot = path.join(workspaceDir, "sessions");

  // ---- Per-session GitManager factory ----
  const createGitManager = deps.createGitManager ?? ((dir: string) => new GitManager(dir));
  const createRepoGit = deps.createRepoGit ?? ((dir: string) => new RepoGit(dir));

  // ---- Session manager ----
  const sessionManager = deps.sessionManager ?? new SessionManager();

  // ---- Repo store ----
  const repoStore = deps.repoStore ?? new RepoStore(
    path.join(workspaceDir, ".vibe-repos.json")
  );

  // ---- Chat history manager ----
  const chatHistoryManager = deps.chatHistoryManager ?? new ChatHistoryManager();

  // ---- Usage/cost tracking manager ----
  const usageManager = deps.usageManager ?? new UsageManager(
    path.join(workspaceDir, ".shipit-usage.json")
  );

  // ---- Auth manager ----
  const authManager = deps.authManager ?? new AuthManager();
  const hasCredentials = authManager.checkCredentials();
  console.log("[server] Claude credentials found:", hasCredentials);

  // ---- Credential store ----
  const credentialStore = deps.credentialStore ?? new CredentialStore(credentialsDir);

  // ---- Global git config (single source of truth for identity) ----
  // Only initialize if not already configured (tests set this up via createTestCredentialStore).
  if (!process.env.GIT_CONFIG_GLOBAL) {
    initGlobalGitConfig(credentialsDir);
  }

  // Load persisted agent env vars into process.env before agent detection
  const storedEnv = credentialStore.getAllAgentEnv();
  for (const [key, value] of Object.entries(storedEnv)) {
    if (ALLOWED_ENV_KEYS.has(key) && !process.env[key]) {
      process.env[key] = value;
    }
  }

  // ---- Agent registry ----
  const agentRegistry = deps.agentRegistry ?? new AgentRegistry({
    checkClaudeAuth: () => authManager.checkCredentials(),
  });
  await agentRegistry.detect();
  const detectedAgents = agentRegistry.list();
  const installedStr = detectedAgents.map((a) => `${a.binary} ${a.installed ? "\u2713" : "\u2717"}`).join(", ");
  const authStr = detectedAgents.map((a) => `${a.binary} ${a.authConfigured ? "\u2713" : "\u2717"}`).join(", ");
  console.log(`[server] Agent CLIs detected: ${installedStr}`);
  console.log(`[server] Agent auth status: ${authStr}`);

  // ---- GitHub auth manager ----
  const githubAuthManager = deps.githubAuthManager ?? new GitHubAuthManager(workspaceDir, credentialStore);
  const hasGitHubToken = githubAuthManager.checkCredentials();
  console.log("[server] GitHub credentials found:", hasGitHubToken);
  if (hasGitHubToken && !deps.githubAuthManager) {
    // Load user info and configure git credentials in the background
    githubAuthManager.loadUserInfo().catch((err) => {
      console.error("[server] Failed to load GitHub user info:", err);
    });
  }

  // ---- Deployment manager ----
  const deploymentManager = deps.deploymentManager ?? (() => {
    const mgr = new DeploymentManager();
    mgr.register(new VercelTarget());
    mgr.register(new CloudflareTarget());
    return mgr;
  })();

  // ---- Deployment store ----
  const deploymentStore = deps.deploymentStore ?? new DeploymentStore(workspaceDir);

  // ---- Feature manager ----
  const featureManager = deps.featureManager ?? new FeatureManager(workspaceDir);

  // ---- Text generation (AI-powered features) ----
  // Tests inject a stub. In production, agentFactory is unavailable (agents
  // live inside session containers), so the default uses agentFactory only
  // when provided, otherwise returns empty string (feature gracefully degrades).
  const generateText = deps.generateText ?? ((prompt: string, cwd?: string): Promise<string> => {
    if (!agentFactory) {
      // No in-process agent available — return empty to degrade gracefully.
      return Promise.resolve("");
    }
    return new Promise((resolve, reject) => {
      const agent = agentFactory(defaultAgentId);
      let text = "";
      agent.on("event", (event: AgentEvent) => {
        if (event.type === "agent_assistant") {
          for (const block of event.content) {
            if (block.type === "text") text += block.text;
          }
        }
      });
      agent.on("done", (exitCode: number) => {
        if (exitCode === 0 || text.length > 0) {
          resolve(text);
        } else {
          reject(new Error("Agent process exited with code " + exitCode));
        }
      });
      agent.on("error", (err: Error) => reject(err));
      agent.run({ prompt, cwd, permissionMode: "auto" });
    });
  });

  // ---- Container manager (Docker isolation) ----
  // In production (serveStatic !== false), every session gets a Docker container.
  // Tests set serveStatic: false and inject stubs, so Docker is not required.
  const isTestMode = deps.serveStatic === false;
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
            memory: cfg.resources.memory * 1024 * 1024,
            cpuQuota: cfg.resources.cpu * 100_000,
            pidsLimit: cfg.resources.pids,
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
  let dockerProxyServer: import("node:http").Server | null = null;
  if (containerManager && !isTestMode) {
    try {
      const bridgeGatewayIp = await resolveBridgeGatewayIp();
      const proxy = createDockerProxy({
        getSessionByContainerIp: (ip: string): DockerProxySessionInfo | undefined => {
          const sc = containerManager!.getSessionByContainerIp(ip);
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
        proxy.listen(0, bridgeGatewayIp, () => {
          const addr = proxy.address();
          if (addr && typeof addr === "object") {
            containerManager!.setDockerProxy(bridgeGatewayIp, addr.port, process.env.SESSION_WORKER_DOCKER_IMAGE);
            console.log(`[server] Docker API proxy listening on ${bridgeGatewayIp}:${addr.port}`);
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

  // ---- Session runner registry (app-level, shared across connections) ----
  // In production, the factory creates ContainerSessionRunner instances that
  // talk to per-session Docker containers via HTTP+SSE. Tests inject a custom
  // factory or claudeFactory (using in-process SessionRunner via registry default).
  const effectiveRunnerFactory: import("./session-runner.js").SessionRunnerFactory | undefined =
    deps.runnerFactory ?? (containerManager ? ((o: Parameters<import("./session-runner.js").SessionRunnerFactory>[0]) => {
      const mgr = containerManager!;

      // Check for an existing container (runner was disposed but container kept running).
      const existing = mgr.get(o.sessionId);

      // Reconnect to running container — avoids expensive container restart cycle.
      // If this is a standby container, claim it (removes standby tracking).
      if (existing && existing.status === "running") {
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
      if (existing && existing.status === "starting") {
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
              if (sc && sc.status === "running") {
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
              sessionDir: o.sessionDir,
              credentialsDir,
              sharedRepoDir: o.sharedRepoDir,
              memoryLimit: sessionConfig.resources.memory * 1024 * 1024,
              cpuQuota: Math.round(sessionConfig.resources.cpu * 100_000),
              pidsLimit: sessionConfig.resources.pids,
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
        sessionDir: o.sessionDir,
        credentialsDir,
        sharedRepoDir: o.sharedRepoDir,
        memoryLimit: sessionConfig.resources.memory * 1024 * 1024,
        cpuQuota: Math.round(sessionConfig.resources.cpu * 100_000),
        pidsLimit: sessionConfig.resources.pids,
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

  // ---- Idle container enforcement ----
  // When more containers are idle than the configured limit, stop the oldest
  // excess containers and dispose their runners.
  const enforceIdleContainerLimit = () => {
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
        containerManager.destroy(sid).catch((err) => {
          console.error(`[idle-cleanup] Failed to destroy container ${sid}:`, getErrorMessage(err));
        });
        runnerRegistry.dispose(sid);
      }
    }
  };

  const runnerRegistry = new SessionRunnerRegistry({
    ...(effectiveRunnerFactory ? { runnerFactory: effectiveRunnerFactory } : {}),
    sharedRepoDirResolver: (sessionId: string) => {
      const session = sessionManager.get(sessionId);
      if (session?.remoteUrl && session?.sessionType === "worktree") {
        return getSharedRepoDir(session.remoteUrl);
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
      });
    },
  });

  // ---- SSE (Server-Sent Events) for global push ----
  // Delivers session_list, repo updates, auth, activity dots to all clients
  // (home page + session page) without requiring a WebSocket connection.
  type SSEClient = { write: (data: string) => boolean; closed: boolean };
  const sseClients = new Set<SSEClient>();

  /** Send an SSE event to all connected SSE clients. */
  const sseBroadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      if (!client.closed) client.write(payload);
    }
  };

  // SSE endpoint — long-lived HTTP response with text/event-stream
  app.get("/api/events", (request, reply) => {
    const origin = request.headers.origin;
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    // Allow cross-origin requests in dev (client on different port)
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    reply.raw.writeHead(200, headers);

    const client: SSEClient = {
      write: (data: string) => reply.raw.write(data),
      closed: false,
    };
    sseClients.add(client);

    // Send initial state snapshot so the client has data immediately
    const sessions = sessionManager.list();
    client.write(`event: session_list\ndata: ${JSON.stringify({ sessions })}\n\n`);
    const repos = repoStore.list();
    client.write(`event: repo_list\ndata: ${JSON.stringify({ repos })}\n\n`);
    const agents = agentRegistry.list().map((a) => ({
      id: a.id, name: a.name, installed: a.installed,
      authConfigured: a.authConfigured, models: a.capabilities.models,
    }));
    client.write(`event: agent_list\ndata: ${JSON.stringify({ agents, defaultAgentId })}\n\n`);

    // Send active runner sessions so sidebar dots are correct on connect
    const activeRunnerSessions: string[] = [];
    for (const session of sessions) {
      const runner = runnerRegistry.get(session.id);
      if (runner?.running) activeRunnerSessions.push(session.id);
    }
    if (activeRunnerSessions.length > 0) {
      client.write(`event: active_runners\ndata: ${JSON.stringify({ sessionIds: activeRunnerSessions })}\n\n`);
    }

    // Send current PR statuses so inline cards and sidebar icons are correct on connect
    const prStatuses = prStatusPoller.getAllStatuses();
    if (prStatuses.length > 0) {
      client.write(`event: pr_status\ndata: ${JSON.stringify({ updates: prStatuses })}\n\n`);
    }

    request.raw.on("close", () => {
      client.closed = true;
      sseClients.delete(client);
    });
  });

  // ---- PR Status Poller ----
  const prStatusPoller = deps.prStatusPoller ?? new PrStatusPoller({
    githubAuth: githubAuthManager,
    sessionManager,
    sseBroadcast,
    runnerRegistry,
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
        const result = await archiveSession(
          sessionManager, runnerRegistry, createRepoGit, getSharedRepoDir, sessionId,
        );
        sseBroadcast("session_list", { sessions: result.sessions });
        console.log(`[pr-poller] Post-merge archive complete for ${sessionId}`);
      } catch (err) {
        console.error(`[pr-poller] Post-merge archive failed for ${sessionId}:`, err);
      }
    },
  });

  // Auto-track sessions with remoteUrl so PR status survives server restart
  for (const session of sessionManager.list()) {
    if (session.remoteUrl) {
      prStatusPoller.trackSession(session.id, session.remoteUrl);
    }
  }

  // ---- Terminal/logs buffer ----
  const MAX_LOG_ENTRIES = 500;
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

  // ---- Deployment event handlers ----
  deploymentManager.on("log", ({ text }: { text: string }) => {
    broadcastLog("deploy", text);
  });

  deploymentManager.on("status", (status: { phase: string }) => {
    sseBroadcast("deploy_status", { phase: status.phase });
  });

  deploymentManager.on("error", (err: { message: string; phase: string }) => {
    sseBroadcast("deploy_error", { message: err.message, phase: err.phase });
  });


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

  /**
   * Create a new isolated session directory with its own git repo.
   * Returns the app-generated session ID and workspace directory path.
   */
  const createSessionDir = async (
    title: string,
    opts?: { skipGitInit?: boolean },
  ): Promise<{ appSessionId: string; sessionDir: string }> => {
    const appSessionId = crypto.randomUUID();
    const sessionDir = path.join(sessionsRoot, appSessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    if (!opts?.skipGitInit) {
      // Initialize a fresh git repo for this session.
      // Identity is inherited from global git config (GIT_CONFIG_GLOBAL).
      // The UI blocks until the user sets their identity, so it must exist by now.
      if (!getGitIdentity()) throw new Error("Cannot create session: git identity not configured");
      const git = createGitManager(sessionDir);
      await git.init();
    }

    // Configure GitHub credentials in the new repo if available.
    // Skip when skipGitInit — the directory isn't a git repo yet (worktree
    // will be created later and has its own configureGitCredentials call).
    if (!opts?.skipGitInit && githubAuthManager.authenticated) {
      githubAuthManager.configureGitCredentials(sessionDir);
    }

    sessionManager.track(appSessionId, title, sessionDir);
    console.log("[server] Created session directory:", sessionDir);

    return { appSessionId, sessionDir };
  };

  // ---- Shared repo directory (one clone per repo URL, all sessions are worktrees) ----
  const reposRoot = path.join(workspaceDir, "repos");

  const getSharedRepoDir = (repoUrl: string): string => {
    return path.join(reposRoot, repoUrlToHash(repoUrl));
  };

  // ---- Warm session pool ----
  // Each repo with status "ready" can have one pre-created warm session.
  // The warm session has a worktree, a runner, and a running preview — but
  // is not visible in the sidebar until the user sends their first message.

  const warmingInProgress = new Set<string>();
  const warmingPromises = new Map<string, Promise<void>>();

  const warmSessionForRepo = (repoUrl: string, opts?: { withStandby?: boolean }): void => {
    const repo = repoStore.get(repoUrl);
    if (!repo || repo.status !== "ready") return;
    // Don't warm if already has a warm session or is currently warming
    if (warmingInProgress.has(repoUrl)) return;
    if (repo.warmSessionId) {
      const existing = sessionManager.get(repo.warmSessionId);
      if (existing) return;
    }
    warmingInProgress.add(repoUrl);

    // Fire-and-forget — warming runs entirely in the background.
    // The promise is stored so the claim endpoint can await it instead
    // of falling to the expensive slow path.
    const p = (async () => {
      try {
        const repoDir = getSharedRepoDir(repoUrl);
        // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
        const repoExists = await fs.stat(repoDir).then(() => true, () => false);
        if (!repoExists) return;

        const branchPrefix = generateBranchPrefix();
        const created = await createSessionDir("Warm session", { skipGitInit: true });
        const { appSessionId, sessionDir } = created;

        // Mark as warm before doing git work
        sessionManager.setWarm(appSessionId, true);
        sessionManager.setRemoteUrl(appSessionId, repoUrl);

        const repoGit = createRepoGit(repoDir);

        // Fetch latest from origin when re-warming after user interaction
        if (opts?.withStandby) {
          try {
            await repoGit.fetch("origin");
          } catch (err) {
            console.error(`[warm] Fetch origin failed for ${repoUrl}:`, getErrorMessage(err));
          }
        }

        // Remove the empty dir (worktree add needs it absent)
        await fs.rm(sessionDir, { recursive: true, force: true });

        const isEmptyRepo = await repoGit.isEmpty();

        if (isEmptyRepo) {
          await fs.mkdir(sessionDir, { recursive: true });
          const sessionGit = createGitManager(sessionDir);
          await sessionGit.init();
          const cloneUrl = githubAuthManager.getAuthenticatedCloneUrl(repoUrl);
          await sessionGit.addRemote("origin", cloneUrl);
          await sessionGit.checkoutNewBranch(branchPrefix);
        } else {
          let startPoint: string | undefined;
          try {
            const defaultBranch = await repoGit.getDefaultBranch();
            if (defaultBranch && !defaultBranch.includes("(")) {
              startPoint = `origin/${defaultBranch}`;
            }
          } catch {
            // Fallback: let git use HEAD
          }
          // Retry worktree creation (git lock contention)
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await repoGit.createWorktree(sessionDir, branchPrefix, startPoint);
              break;
            } catch (wtErr) {
              if (attempt < 2) {
                await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
              } else {
                throw wtErr;
              }
            }
          }
        }

        // Configure credentials
        if (githubAuthManager.authenticated) {
          githubAuthManager.configureGitCredentials(sessionDir);
        }

        sessionManager.setWorktreeInfo(appSessionId, {
          branch: branchPrefix,
          sessionType: isEmptyRepo ? "standalone" : "worktree",
        });

        // Store the warm session ID on the repo.
        // Container + runner are created on-demand when the user activates
        // the session (WS connect → activateSession → getOrCreate).
        repoStore.setWarmSessionId(repoUrl, appSessionId);

        // Boot a standby container so the next activation is instant
        if (opts?.withStandby && containerManager) {
          const session = sessionManager.get(appSessionId);
          const sharedRepoDir = session?.sessionType === "worktree" ? repoDir : undefined;
          const realCount = containerManager.size - containerManager.standbyCount;
          const maxIdle = credentialStore.getMaxIdleContainers();
          if (realCount < maxIdle) {
            const config = containerManager.buildConfig({
              sessionId: appSessionId,
              sessionDir,
              credentialsDir,
              sharedRepoDir,
            });
            // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget in sync warming callback
            containerManager.createStandby(config).then((sc) => {
              console.log(`[warm] Standby container ready for ${appSessionId} at ${sc.workerUrl}`);
            }).catch((err) => {
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
  };

  // ---- Migration: derive RepoStore from existing sessions ----
  // On first startup with the new code, scan sessions for unique remoteUrl values.
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

  // ---- Startup: validate warm sessions + re-warm missing ----
  // After restart, runners/containers are gone. We intentionally do NOT boot
  // standby containers here — that would start containers for every repo the
  // user has cloned. Instead, the first "New Session" per repo cold-starts
  // (~1-2s), which triggers re-warming with a standby container so that
  // subsequent "New Session" clicks for the same repo are instant.
  setTimeout(() => {
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
        sessionManager.delete(id);
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
          console.log(`[warm] Stale warm session ${repo.warmSessionId} — worktree missing, re-warming`);
          if (containerManager?.isStandby(repo.warmSessionId)) {
            containerManager.destroy(repo.warmSessionId).catch((err) => {
              console.error(`[warm] Failed to destroy stale standby:`, getErrorMessage(err));
            });
          }
          repoStore.setWarmSessionId(repo.url, undefined);
          warmSessionForRepo(repo.url);
        } else {
          console.log(`[warm] Warm session ${repo.warmSessionId} validated (worktree exists)`);
        }
      }
    }
    // Re-warm repos that have no warm session at all (+ migrated repos)
    for (const url of migratedRepoUrls) {
      warmSessionForRepo(url);
    }
    for (const repo of repoStore.list()) {
      if (!repo.warmSessionId && repo.status === "ready"
          && !migratedRepoUrls.includes(repo.url)) {
        warmSessionForRepo(repo.url);
      }
    }
  }, 0);

  // ---- HTTP API routes ----
  await registerApiRoutes(app, {
    sessionManager,
    repoStore,
    createGitManager,
    createRepoGit,
    agentRegistry,
    githubAuthManager,
    credentialStore,
    defaultAgentId,
    workspaceDir,
    deploymentManager,
    deploymentStore,
    usageManager,
    runnerRegistry,
    chatHistoryManager,
    authManager,
    broadcastLog,
    sseBroadcast,
    getSharedRepoDir,
    createSessionDir,
    generateText,
    sessionsRoot,
    warmSessionForRepo,
    waitForWarmSession: (repoUrl: string) => warmingPromises.get(repoUrl),
    createSessionDirFull: createSessionDir,
    containerManager: containerManager ?? undefined,
    prStatusPoller,
  });

  // ---- Preview reverse proxy (container mode) ----
  // Routes /preview/:sessionId/:port/* and /api/preview-health/* to the
  // container's bridge IP. Must be registered BEFORE static file serving
  // so the SPA fallback (setNotFoundHandler) doesn't catch these routes.
  if (containerManager) {
    registerPreviewProxy(app, { containerManager });
  }

  // Serve the built client files from dist/client/
  if (shouldServeStatic) {
    const clientDir = path.resolve(process.cwd(), "dist/client");
    try {
      await app.register(fastifyStatic, {
        root: clientDir,
        prefix: "/",
        wildcard: false,
      });
      // SPA fallback — serve index.html for non-file routes
      app.setNotFoundHandler((_req, reply) => {
        reply.sendFile("index.html", clientDir);
      });
    } catch {
      // Client build may not exist during dev; that's fine
      console.log("[server] No built client found at", clientDir);
    }
  }

  // ---- Per-session WebSocket route ----



  // ---- Per-session WebSocket route ----
  // Session-scoped WS: auto-activates the session on connect, no activate_session needed.
  // The session ID is in the URL path. Agent preference via ?agent= query param.
  app.get<{ Params: { sessionId: string }; Querystring: { agent?: string } }>(
    "/ws/sessions/:sessionId",
    { websocket: true },
    (socket, request) => {
      const { sessionId } = request.params;
      const session = sessionManager.get(sessionId);
      if (!session) {
        socket.close(4004, "Session not found");
        return;
      }
      console.log(`[ws] session client connected: ${sessionId}`);

      // Per-connection state — initialized from URL params
      let activeAppSessionId: string | undefined = sessionId;
      let activeSessionDir: string | null = session.workspaceDir ?? null;
      const requestedAgent = request.query.agent as AgentId | undefined;
      let perConnectionAgentId: AgentId = requestedAgent ?? defaultAgentId;
      let attachedRunner: SessionRunnerInterface | null = null;
      let runnerMessageListener: ((msg: WsServerMessage) => void) | null = null;
      let previewRetryListener: ((msg: WsServerMessage) => void) | null = null;

      const send = (msg: WsServerMessage) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(msg));
        }
      };

      // ---- Runner attach/detach (same as /ws) ----
      const attachToRunner = (runner: SessionRunnerInterface) => {
        if (attachedRunner === runner) return;
        detachFromRunner();
        attachedRunner = runner;
        runnerMessageListener = (msg: WsServerMessage) => { send(msg); };
        runner.on("message", runnerMessageListener);
        runner.attachViewer();
        for (const msg of runner.getTurnEventBuffer()) { send(msg); }
        if (runner.getQueueSnapshot().length > 0) {
          send({ type: "queue_updated", queue: runner.getQueueSnapshot() });
        }
        if (runner.running || runner.queueLength > 0 || runner.getTurnEventBuffer().length > 0) {
          send({ type: "session_status", sessionId: runner.sessionId, running: runner.running, queueLength: runner.queueLength });
        }
        // Send preview_status on attach only if the runner has definitive state.
        // For container runners waiting on SSE, the runner will emit the status
        // itself once the worker reports its preview state. Until then, the client
        // stays at preview=null (shows a loading spinner).
        if (runner.previewStatusKnown) {
          send(runner.buildPreviewStatus());
        } else {
          // Preview state not yet known (SSE still connecting to worker).
          // The normal message listener already forwards preview_status, but
          // React 18 batching can swallow it when many WS messages arrive in
          // the same tick. Register a one-shot listener that re-sends
          // preview_status in a separate microtask to avoid being batched.
          previewRetryListener = (msg: WsServerMessage) => {
            if (msg.type === "preview_status") {
              runner.off("message", previewRetryListener!);
              previewRetryListener = null;
              queueMicrotask(() => {
                if (socket.readyState === 1) {
                  send(runner.buildPreviewStatus());
                }
              });
            }
          };
          runner.on("message", previewRetryListener);
        }
      };

      const detachFromRunner = () => {
        if (attachedRunner) {
          if (runnerMessageListener) attachedRunner.off("message", runnerMessageListener);
          if (previewRetryListener) attachedRunner.off("message", previewRetryListener);
          attachedRunner.detachViewer();
        }
        attachedRunner = null;
        runnerMessageListener = null;
        previewRetryListener = null;
      };

      const scheduleAutoPush = (git: GitManager) => {
        const runner = attachedRunner;
        if (!runner) return;
        runner.clearPushTimer();
        runner.setPushTimer(setTimeout(async () => {
          runner.setPushTimer(null);
          try {
            if (!githubAuthManager.authenticated) return;
            const branch = await pushToOrigin(git);
            if (branch) {
              runner.emitMessage({ type: "github_push_result", success: true, message: `Auto-pushed to origin/${branch}`, branch });
            }
          } catch (err) {
            const errMsg = getErrorMessage(err);
            const text = errMsg.includes("workflow")
              ? "Auto-push failed: your GitHub token needs the `workflow` scope to push changes to GitHub Actions workflow files. Update your token at https://github.com/settings/tokens."
              : `Auto-push failed: ${errMsg}`;
            broadcastLog("server", text);
            runner.emitMessage({ type: "log_entry", source: "server", text, timestamp: new Date().toISOString() });
          }
        }, autoPushDebounceMs));
      };

      const getActiveDir = (): string => activeSessionDir ?? workspaceDir;
      const getActiveGitManager = (): GitManager => {
        if (!activeSessionDir) throw new Error("No active session — git operations require a session");
        return createGitManager(activeSessionDir);
      };

      const activateSession = async (sid: string) => {
        const s = sessionManager.get(sid);
        activeAppSessionId = sid;
        const dir = s?.workspaceDir ?? null;
        const existingRunner = runnerRegistry.get(sid);
        if (existingRunner) {
          attachToRunner(existingRunner);
        } else if (dir) {
          const runner = runnerRegistry.getOrCreate(sid, dir, perConnectionAgentId);
          attachToRunner(runner);
        } else {
          detachFromRunner();
        }
        if (dir !== activeSessionDir) {
          activeSessionDir = dir;
        }
        if (dir) checkGitIdentity(dir);
      };

      const checkGitIdentity = async (_sessionDir: string) => {
        if (getGitIdentity()) return;
        send({ type: "git_identity_required" });
      };

      const readSystemPrompt = async (): Promise<string | undefined> => {
        try {
          const content = await fs.readFile(path.join(workspaceDir, ".shipit", "system-prompt.md"), "utf-8");
          const trimmed = content.trim();
          return trimmed || undefined;
        } catch { return undefined; }
      };

      // Wrap broadcastLog so it both buffers globally AND sends to attached WS viewers
      const sessionBroadcastLog: typeof broadcastLog = (source, text) => {
        broadcastLog(source, text); // global buffer
        const entry: WsLogEntry = { type: "log_entry", source, text, timestamp: new Date().toISOString() };
        if (attachedRunner) {
          attachedRunner.emitMessage(entry);
        } else {
          send(entry);
        }
      };

      // ---- Handler context ----
      const ctx: ConnectionCtx & RunnerCtx & AppCtx = {
        send, broadcastLog: sessionBroadcastLog, sseBroadcast,
        getActiveDir, getActiveGitManager,
        getActiveAppSessionId: () => activeAppSessionId,
        setActiveAppSessionId: (id) => { activeAppSessionId = id; },
        getActiveSessionDir: () => activeSessionDir,
        setActiveSessionDir: (dir) => { activeSessionDir = dir; },
        activateSession,
        agentFactory: (agentId: AgentId) => {
          if (attachedRunner?.createAgent) return attachedRunner.createAgent(agentId);
          if (agentFactory) return agentFactory(agentId);
          throw new Error("No agent factory available");
        },
        getAgent: () => attachedRunner?.getAgent() ?? null,
        setAgent: (a) => { if (attachedRunner) attachedRunner.setAgent(a); },
        getActiveAgentId: () => attachedRunner?.agentId ?? perConnectionAgentId,
        setActiveAgentId: (id) => { perConnectionAgentId = id; if (attachedRunner) attachedRunner.agentId = id; },
        getIsClaudeRunning: () => attachedRunner?.running ?? false,
        setIsClaudeRunning: (v) => { if (attachedRunner) attachedRunner.running = v; },
        getWasInterrupted: () => attachedRunner?.wasInterrupted ?? false,
        setWasInterrupted: (v) => { if (attachedRunner) attachedRunner.wasInterrupted = v; },
        getTurnSummary: () => attachedRunner?.turnSummary ?? "",
        setTurnSummary: (s) => { if (attachedRunner) attachedRunner.turnSummary = s; },
        getAccumulatedText: () => attachedRunner?.accumulatedText ?? "",
        setAccumulatedText: (s) => { if (attachedRunner) attachedRunner.accumulatedText = s; },
        getAccumulatedToolUse: () => attachedRunner?.accumulatedToolUse ?? [],
        setAccumulatedToolUse: (blocks) => { if (attachedRunner) attachedRunner.accumulatedToolUse = blocks; },
        getChatMessageGroups: () => attachedRunner?.chatMessageGroups ?? [],
        setChatMessageGroups: (groups) => { if (attachedRunner) attachedRunner.chatMessageGroups = groups; },
        getNeedsNewMessageGroup: () => attachedRunner?.needsNewMessageGroup ?? true,
        setNeedsNewMessageGroup: (v) => { if (attachedRunner) attachedRunner.needsNewMessageGroup = v; },
        getMessageQueue: () => attachedRunner?.messageQueue ?? [],
        clearMessageQueue: () => { if (attachedRunner) attachedRunner.clearQueue(); },
        getTerminal: () => attachedRunner?.getTerminal() ?? null,
        setTerminal: (t) => { if (attachedRunner) attachedRunner.setTerminal(t); },
        clearLogBuffer: () => { logBuffer = []; },
        getRunner: () => attachedRunner,
        getRunnerRegistry: () => runnerRegistry,
        attachToRunner, detachFromRunner,
        sessionManager, chatHistoryManager, createGitManager, createRepoGit,
        githubAuthManager, deploymentManager, deploymentStore,
        featureManager, usageManager, authManager, agentRegistry, credentialStore,
        repoStore, warmSessionForRepo, createSessionDir, generateText,
        getSharedRepoDir, checkGitIdentity, readSystemPrompt, scheduleAutoPush,
        prStatusPoller,
        workspaceDir, sessionsRoot, defaultAgentId,
      };

      // Auto-activate the session on connect
      activateSession(sessionId);

      // Send log buffer and git identity check
      for (const entry of logBuffer) { send(entry); }
      if (!getGitIdentity()) { send({ type: "git_identity_required" }); }

      // Re-send preview_status after the log buffer so it isn't lost if the
      // browser batches rapid WS messages (React 18 automatic batching can
      // cause intermediate setLastMessage() calls to be skipped when many
      // frames arrive within a single rendering cycle).
      if (logBuffer.length > 0) {
        const runner = runnerRegistry.get(sessionId);
        if (runner?.previewStatusKnown) {
          send(runner.buildPreviewStatus());
        }
      }

      // Always send PR lifecycle card for sessions with a remote.
      // The SSE pr_status snapshot handles open/merged PRs; this covers the
      // "ready" phase (branch info + diff stats, no PR created yet).
      {
        const session = sessionManager.get(sessionId);
        if (session?.remoteUrl && session.workspaceDir && session.branchRenamed) {
          const prStatus = prStatusPoller.getStatus(sessionId);
          if (!prStatus) {
            // No open/merged PR — send branch info and diff stats
            (async () => {
              try {
                const git = createGitManager(session.workspaceDir!);
                const headBranch = session.branch || await git.getCurrentBranch();
                const { insertions, deletions } = await git.diffStatVsBranch("main");
                send({
                  type: "pr_lifecycle_update",
                  sessionId,
                  cardId: `pr-card-${sessionId}`,
                  phase: "ready",
                  headBranch,
                  totalInsertions: insertions,
                  totalDeletions: deletions,
                });
              } catch (err) {
                send({
                  type: "pr_lifecycle_update",
                  sessionId,
                  cardId: `pr-card-${sessionId}`,
                  phase: "error",
                  errorMessage: err instanceof Error ? err.message : "Failed to read git status",
                });
              }
            })();
          }
        }
      }

      // Message dispatcher — same as /ws but without new_session and activate_session
      socket.on("message", async (raw: Buffer) => {
        let msg: WsClientMessage;
        try { msg = JSON.parse(raw.toString()); } catch { send({ type: "error", message: "Invalid JSON" }); return; }

        switch (msg.type) {
          case "terminal_start": return terminalHandlers.handleTerminalStart(ctx, msg);
          case "terminal_input": return terminalHandlers.handleTerminalInput(ctx, msg);
          case "terminal_resize": return terminalHandlers.handleTerminalResize(ctx, msg);
          case "clear_logs": return terminalHandlers.handleClearLogs(ctx);
          case "set_agent": {
            const agentId = msg.agentId;
            const info = agentRegistry.get(agentId);
            if (!info) { send({ type: "error", message: `Unknown agent: ${agentId}` }); return; }
            if (!info.installed) { send({ type: "error", message: `${info.name} CLI is not installed` }); return; }
            if (!info.authConfigured) {
              const envKey = agentId === "codex" ? "OPENAI_API_KEY" : "";
              send({ type: "error", message: `${envKey || "API key"} is not set. Add it in Settings → Agents.` });
              return;
            }
            ctx.setActiveAgentId(agentId);
            return;
          }
          // new_session and activate_session are NOT handled — session is implicit from URL
          case "initiate_deploy": return deployHandlers.handleInitiateDeploy(ctx, msg);
          case "cancel_deploy": return deployHandlers.handleCancelDeploy(ctx);
          case "rollback_code": return rollbackHandlers.handleRollbackCode(ctx, msg);
          case "rollback_code_and_chat": return rollbackHandlers.handleRollbackCodeAndChat(ctx, msg);
          case "fork_session_from_message": return rollbackHandlers.handleForkSessionFromMessage(ctx, msg);
          case "cancel_queued_message": return miscHandlers.handleCancelQueuedMessage(ctx, msg);
          case "interrupt_claude": return miscHandlers.handleInterruptClaude(ctx);
          case "init_preview_config": {
            sendMessageHandlers.handleSendMessage(ctx, {
              type: "send_message",
              text: `Analyze this project and create a shipit.yaml file at the workspace root.
The file configures the live preview and dependency installation.

For projects with dependencies (npm, yarn, pip, etc.), include an install command:

install: npm install
preview:
  command: npm run dev
  ports: [3000]

For static HTML projects (no build step, no dependencies):

preview:
  html: index.html

Look at package.json scripts, framework config files, and project structure
to determine the correct install command, preview mode, command, and ports.`,
            });
            return;
          }
          case "send_message": return sendMessageHandlers.handleSendMessage(ctx, msg);
          case "answer_question": return sendMessageHandlers.handleAnswerQuestion(ctx, msg);
        }
      });

      socket.on("close", () => {
        console.log(`[ws] session client disconnected: ${sessionId}`);
        detachFromRunner();
        enforceIdleContainerLimit();
      });
    },
  );

  // ---- Container health monitoring ----
  // When a container dies unexpectedly (OOM, crash), notify viewers and clean up.
  if (containerManager) {
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

  // Graceful shutdown — register once via app hook rather than per-call
  // process.on() to avoid MaxListeners warnings when buildApp() is called
  // repeatedly in tests.
  app.addHook("onClose", async () => {
    authManager.kill();
    runnerRegistry.disposeAll();
    if (dockerProxyServer) {
      await new Promise<void>((resolve) => dockerProxyServer!.close(() => resolve()));
    }
    if (containerManager) {
      await containerManager.dispose();
    }
  });

  return app;
}

// Only start the server when this file is the entry point (not when imported by tests).
// Vitest sets process.env.VITEST; alternatively check import.meta.url vs process.argv[1].
if (!process.env.VITEST) {
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
