import type { GitManager } from "../shared/git.js";
import type { SessionRunnerFactory } from "./session-runner.js";
import { SessionRunnerRegistry } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionContainerManager } from "./session-container.js";
import type { CredentialStore } from "./credential-store.js";
import type { SecretStore } from "./secret-store.js";
import type { PlatformCredentialProvider } from "./platform-credentials.js";
import type { AgentId, AgentProcess, WsLogEntry } from "../shared/types.js";
import type { RuntimeMode } from "./app-di.js";
import { pushToOrigin } from "./git-utils.js";
import { isNonFastForwardError } from "./services/git.js";
import { getErrorMessage } from "./validation.js";
import { setupServiceManager } from "./service-manager-setup.js";

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
   * Account-level credential store (docs/088). Used to wire ServiceManager's
   * `mcpAgentEnvLoader` (merging `mcp__*` secrets into the agent env) and to
   * trigger MCP npm-package installs at session activation. Optional so test
   * setups without credentials still work.
   */
  credentialStore?: CredentialStore;
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
    credentialStore, secretStore, platformCredentials, dockerSecretsConfig, runtimeMode, broadcastLog,
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
          credentialStore,
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
