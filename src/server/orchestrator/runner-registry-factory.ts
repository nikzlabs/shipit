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
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { AutoConflictResolveManager } from "./auto-conflict-resolve-manager.js";
import type { AgentId, AgentProcess, WsLogEntry, SubscriptionLimitsMap } from "../shared/types.js";
import type { RuntimeMode } from "./app-di.js";
import type { UsageManager } from "./usage.js";
import type { AuthManager } from "./agents/claude/auth-manager.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { PrepareRunParamsFn } from "./agent-run-params-prep.js";
import { pushToOrigin } from "./git-utils.js";
import { isNonFastForwardError } from "./services/git.js";
import { getErrorMessage } from "./validation.js";
import { setupServiceManager } from "./service-manager-setup.js";
import { buildAgentRunParams } from "./session-agent-run-params.js";
import { finalizeSessionAgentEnvironment, prepareSessionAgentEnvironment } from "./session-agent-env.js";
import { emitPrLifecycleAfterCommit } from "./services/pr-lifecycle.js";
import { postTurnCommit } from "./ws-handlers/post-turn.js";

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
  /**
   * docs/149 — credentials root used by the post-system-turn finalize hook
   * (writes a CLI-rotated OAuth token back to the orchestrator source).
   * Optional so test setups without container creds still work.
   */
  credentialsDir?: string;
  /**
   * docs/149 — used by the system-turn `buildRunParams` hook to load the
   * user's optional Settings > Instructions suffix. Optional so test setups
   * can skip the file read.
   */
  readSystemPrompt?: () => Promise<string | undefined>;
  /**
   * docs/149 — used by the post-system-turn PR-lifecycle flow when auto-
   * create-PR is on, to derive a PR description from chat history. Optional
   * so tests can leave the flow unwired.
   */
  generateText?: (prompt: string, cwd: string) => Promise<string>;
  /**
   * docs/149 — lazy resolver for the PR-status poller. Lazy because the
   * poller is constructed AFTER the runner registry (it depends on the
   * registry) — without a getter the post-turn flow would close over a null
   * reference. Optional so tests omit it.
   */
  getPrStatusPoller?: () => PrStatusPoller | undefined;
  /**
   * docs/146 — lazy resolver for the auto-conflict-resolve manager. The
   * manager is constructed inside the poller (one tick after the registry
   * exists), so we accept a lazy getter rather than a direct ref. Wired so
   * the runner's `"idle"` event re-evaluates any session whose manager state
   * is `deferred`. Optional — when absent, the runner-idle hook just keeps
   * doing what `enforceIdleContainerLimit` did before.
   */
  getAutoConflictResolveManager?: () => AutoConflictResolveManager | undefined;
  /**
   * Usage manager — used by `wireAgentListeners` to record per-turn token /
   * cost telemetry on `agent_result`. Shared with the WS path so a system-
   * dispatched turn lands in the same `usage_turns` series as a user-typed
   * turn (cost graph, ContextDial, etc.).
   */
  usageManager: UsageManager;
  /**
   * Claude auth manager — used by `wireAgentListeners` to kick off the OAuth
   * flow when the CLI emits `auth_required`. Without it a system turn that
   * runs into a stale token would just emit `auth_required` with no
   * follow-up. Shared with the WS path.
   */
  authManager: AuthManager;
  /**
   * Optional — push a fresh rate-limit snapshot for any agent (from an
   * `agent_rate_limits` AgentEvent) into the subscription-limits badge.
   * Mirrors the WS-path `AppCtx.recordAgentRateLimits`. Wired by
   * `index.ts` after the limits providers are constructed.
   */
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
  ) => void;
  /**
   * Optional — latest subscription-limits snapshot used by the listener to
   * reclassify generic "monthly usage limit" CLI errors into the precise
   * "5h usage limit" message when a session window is exhausted.
   */
  getSubscriptionLimitsSnapshot?: () => SubscriptionLimitsMap;
  /**
   * docs/153 — fire-and-forget nudge to the Claude OAuth refresher. Forwarded
   * into the listener so dispatched/system turns also heal a stale token via
   * the orchestrator-owned refresher when the CLI emits `auth_required`.
   * Mirrors the WS-path `AppCtx.nudgeClaudeOAuthRefresh`. (Most consumers
   * should prefer `onAgentAuthRequired` so the dispatch is keyed by agent.)
   */
  nudgeClaudeOAuthRefresh?: () => void;
  /**
   * docs/155 — per-agent dispatch for the listener's `auth_required` handler.
   * Mirrors the WS-path `AppCtx.onAgentAuthRequired`. Plumbed through here so
   * system-turn listeners get the same routing.
   */
  onAgentAuthRequired?: (agentId: AgentId) => void;
  /**
   * docs/155 Phase 2c — per-agent auth manager map. Forwarded to the
   * `AgentListenerDeps` so a system-turn that hits `auth_required` restarts
   * the failing backend's auth flow (not always Claude OAuth). Optional;
   * absent in tests that don't construct a real auth manager.
   */
  authManagers?: Map<AgentId, AgentAuthManager>;
  /**
   * docs/155 Phase 3 — per-agent run-params prep hooks. Forwarded into the
   * system-turn `buildRunParams` so dispatched/CI-fix turns inject the same
   * Claude-only / Codex-only fields the WS path does. Optional; absent in
   * minimal test setups.
   */
  runParamsPreps?: Map<AgentId, PrepareRunParamsFn>;
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
    credentialsDir, readSystemPrompt, generateText, getPrStatusPoller, getAutoConflictResolveManager,
    usageManager, authManager, authManagers, recordAgentRateLimits, getSubscriptionLimitsSnapshot,
    nudgeClaudeOAuthRefresh, onAgentAuthRequired, runParamsPreps,
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
    onRunnerIdle: (sessionId: string) => {
      enforceIdleContainerLimit();
      // docs/146 — re-evaluate any session whose manager state is `deferred`
      // (agent was busy when the conflict was detected) the moment the agent
      // goes idle. Cooldown-driven retry runs through `handleTransition` on
      // the next poll, NOT here. Fire-and-forget — manager owns its own
      // error logging.
      const mgr = getAutoConflictResolveManager?.();
      if (mgr) {
        mgr.onRunnerIdle(sessionId).catch((err: unknown) => {
          console.error(`[runner-registry] auto-resolve onRunnerIdle error for ${sessionId}:`, err);
        });
      }
    },
    onRunnerCreated: (runner) => {
      // Shared listener deps — same shape `wireAgentListeners` consumes on
      // the WS path. The system-turn flow now goes through the same listener,
      // so a Fix CI / child-session / `/agent/dispatch` turn produces chat
      // history with the same message-group structure (tool calls visible,
      // assistant text split at tool-result boundaries) as a user-typed turn.
      const listenerDeps = {
        sessionManager,
        chatHistoryManager,
        usageManager,
        authManager,
        sseBroadcast,
        broadcastLog: (source: WsLogEntry["source"], text: string) =>
          broadcastLog(runner.sessionId, source, text),
        getSelectedModel: () => sessionManager.get(runner.sessionId)?.model,
        ...(authManagers ? { authManagers } : {}),
        ...(recordAgentRateLimits ? { recordAgentRateLimits } : {}),
        ...(getSubscriptionLimitsSnapshot ? { getSubscriptionLimitsSnapshot } : {}),
        ...(nudgeClaudeOAuthRefresh ? { nudgeClaudeOAuthRefresh } : {}),
        ...(onAgentAuthRequired ? { onAgentAuthRequired } : {}),
      };
      // Shared debounced auto-push for a resolved GitManager. Used by both the
      // `scheduleAutoPush(sessionDir)` dep and the `commitTurn` helper below, so
      // the dispatch path and the shared `postTurnCommit` push identically.
      const schedulePushGit = (git: GitManager): void => {
        if (!githubAuthManager.authenticated) return;
        runner.clearPushTimer();
        runner.setPushTimer(setTimeout(async () => {
          runner.setPushTimer(null);
          try {
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
      };
      runner.setSystemTurnDeps({
        agentFactory: (agentId) => {
          if (runner.createAgent) return runner.createAgent(agentId);
          if (agentFactory) return agentFactory(agentId);
          throw new Error("No agent factory available for system turn");
        },
        autoCommit: async (sessionDir, summary) => {
          const git = createGitManager(sessionDir);
          const parentHash = await git.getHeadHash();
          const { commitHash, conflictedFiles, rebaseInProgress } = await git.autoCommit(summary);
          return { commitHash, parentHash, conflictedFiles, rebaseInProgress };
        },
        scheduleAutoPush: (sessionDir) => schedulePushGit(createGitManager(sessionDir)),
        listenerDeps,
        // docs/149 — assemble full AgentRunParams for system turns. Without
        // this, spawned-session / CI-auto-fix turns ran with only
        // `{ prompt, sessionId, cwd }` (no system prompt, no settings, no
        // model, no MCP, no autoCreatePr). When `credentialStore` is absent
        // (extreme-minimal test setup) we fall back to the minimal shape
        // so we don't regress those callers.
        buildRunParams: async (sessionId, agentId, prompt) => {
          const session = sessionManager.get(sessionId);
          if (!credentialStore) {
            return {
              prompt,
              cwd: runner.sessionDir,
              ...(session?.agentSessionId !== undefined ? { sessionId: session.agentSessionId } : {}),
            };
          }
          return buildAgentRunParams({
            deps: {
              credentialStore,
              githubAuthManager,
              sessionManager,
              readSystemPrompt: readSystemPrompt ?? (() => Promise.resolve(undefined)),
              getSelectedModel: () => session?.model,
              ...(runParamsPreps ? { runParamsPreps } : {}),
            },
            sessionId,
            agentId,
            prompt,
            sessionDir: runner.sessionDir,
            ...(session?.agentSessionId !== undefined ? { agentSessionId: session.agentSessionId } : {}),
          });
        },
        // docs/149 — write back any CLI-rotated OAuth token after a system
        // turn lands. Mirrors the WS-path `syncTokenBackAfterTurn` discipline.
        ...(credentialsDir && credentialStore ? {
          finalizeAgentEnv: (sessionId, agentId) => {
            finalizeSessionAgentEnvironment(runner, {
              sessionId,
              agentId,
              deps: { credentialsDir, credentialStore, sessionManager },
            });
          },
          // Re-sync the freshest OAuth token immediately before spawn, the same
          // late moment the WS path does. Closes the staleness window that let a
          // quick/child/CI-fix turn spawn with a sibling-rotated (dead) token →
          // "Not logged in". Idempotent with the service fn's earlier call.
          prepareAgentEnv: async (sessionId, agentId) => {
            await prepareSessionAgentEnvironment(runner, {
              sessionId,
              agentId,
              deps: { credentialsDir, credentialStore, sessionManager },
            });
          },
        } : {}),
        // Single shared commit helper — same `postTurnCommit` the WS path uses
        // (workspace-locked auto-commit + conflict notice + auto-push + commit
        // link). The dispatch path routes through this instead of its inline
        // commit block so both transports commit identically.
        commitTurn: ({ sessionDir, sessionId, summary, turnStartHeadHash, runner: turnRunner, emit }) =>
          postTurnCommit(
            {
              createGitManager,
              chatHistoryManager,
              scheduleAutoPush: (git) => schedulePushGit(git),
            },
            { sessionDir, sessionId, emit, turnSummary: summary, turnStartHeadHash, runner: turnRunner },
          ),
        // docs/149 — emit the PR lifecycle card after a system-turn commit.
        // Lazy poller resolution because the poller is constructed AFTER the
        // runner registry; the closure fires post-turn, by which time it's set.
        ...(generateText ? {
          postTurnPrFlow: async (sessionId, sessionDir, commitHash, emit) => {
            const prStatusPoller = getPrStatusPoller?.();
            if (!prStatusPoller || !credentialStore) return;
            await emitPrLifecycleAfterCommit({
              deps: {
                sessionManager,
                prStatusPoller,
                githubAuthManager,
                credentialStore,
                chatHistoryManager,
                generateText,
                createGitManager,
              },
              sessionId,
              sessionDir,
              commitHash,
              emit,
            });
          },
        } : {}),
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
