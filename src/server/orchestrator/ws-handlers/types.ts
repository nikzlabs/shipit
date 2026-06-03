import type { WsServerMessage, WsLogEntry } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { SessionManager } from "../sessions.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { UsageManager } from "../usage.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { AgentAuthManager } from "../agent-auth-manager.js";
import type { PrepareRunParamsFn } from "../agent-run-params-prep.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { RepoStore } from "../repo-store.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { ReleaseStatusPoller } from "../release-status-poller.js";
import type { AgentId, AgentProcess } from "../../shared/types.js";
import type { SubscriptionLimitsMap } from "../../shared/types.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, QueuedMessage } from "../session-runner.js";

// Re-export so existing consumers of types.ts don't break
export type { QueuedMessage };

// ---------------------------------------------------------------------------
// Sub-context interfaces — see docs/054-handler-context-refactor/plan.md
// ---------------------------------------------------------------------------

/**
 * Per-connection state and communication.
 * Scoped to a single WebSocket connection's lifecycle.
 */
export interface ConnectionCtx {
  // Communication
  send: (msg: WsServerMessage) => void;
  broadcastLog: (source: WsLogEntry["source"], text: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;

  // Active session accessors
  getActiveDir: () => string;
  getActiveGitManager: () => GitManager;
  getActiveAppSessionId: () => string | undefined;
  setActiveAppSessionId: (id: string | undefined) => void;
  getActiveSessionDir: () => string | null;
  setActiveSessionDir: (dir: string | null) => void;
  activateSession: (sessionId: string) => void | Promise<void>;

  // Per-connection helpers
  checkGitIdentity: (dir: string) => void;
  readSystemPrompt: () => Promise<string | undefined>;
  scheduleAutoPush: (git: GitManager, sessionId?: string) => void;
  clearLogBuffer: () => void;
}

/**
 * Per-session runner delegation.
 *
 * The previous incarnation of this interface exposed ~15 setters/getters
 * that delegated to a per-connection `attachedRunner`. They were a hazard:
 * after a WS disconnect, `attachedRunner` was null and every setter silently
 * no-oped. State mutations from async closures vanished.
 *
 * The setters are gone. Resolve the runner via `resolveRunner(ctx)` (which
 * prefers the registry) and mutate `runner.X` directly. See
 * `docs/095-runner-ctx-simplification/plan.md`.
 */
export interface RunnerCtx {
  // Agent factory — delegates to runner.createAgent if available.
  agentFactory: (agentId: AgentId) => AgentProcess;

  // Per-connection identifiers — these don't depend on runner state.
  getActiveAgentId: () => AgentId;
  setActiveAgentId: (id: AgentId) => void;
  getSelectedModel: () => string | undefined;
  setSelectedModel: (model: string | undefined) => void;

  // Runner lookup — the ONLY supported way to access runner state.
  /** Get the runner attached to this connection (if any). Prefer
   *  `resolveRunner(ctx)` from `./resolve-runner.ts`, which falls back to
   *  the registry — that survives WS disconnects, which `getRunner()` does
   *  not. */
  getRunner: () => SessionRunnerInterface | null;
  /** Get the app-level runner registry. The preferred way to find a runner
   *  by session ID, including from async closures and post-disconnect code. */
  getRunnerRegistry: () => SessionRunnerRegistry;
  /** Attach this connection to a runner (detaches previous). */
  attachToRunner: (runner: SessionRunnerInterface) => void;
  /** Detach this connection from its current runner. */
  detachFromRunner: () => void;
}

/**
 * App-wide manager references, factories, and config.
 * Shared singletons that live for the lifetime of the server process.
 */
export interface AppCtx {
  // Managers
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  createGitManager: (dir: string) => GitManager;
  createRepoGit: (dir: string) => RepoGit;
  githubAuthManager: GitHubAuthManager;
  usageManager: UsageManager;
  authManager: AuthManager;
  /**
   * Per-agent auth manager map (docs/155 Phase 2). Drives the
   * `auth_required` dispatch in `agent-listeners.ts` — the failing turn's
   * backend gets its own auth flow restarted, not Claude's.
   */
  authManagers: Map<AgentId, AgentAuthManager>;
  /**
   * Per-agent run-params prep hooks (docs/155 Phase 3). Each backend's hook
   * injects its own Claude-only / Codex-only fields onto `AgentRunParams`
   * (Claude: `settingsPath`, `autoCreatePr`; Codex: identity). The shared
   * `buildAgentRunParams` invokes the hook for the spawning agent so the
   * old `agentId === "claude" ? "/etc/shipit/managed-settings.json" : …`
   * branch can go away. Optional on the AppCtx because legacy test setups
   * skip the map; fallback inside `buildAgentRunParams` is identity.
   */
  runParamsPreps?: Map<AgentId, PrepareRunParamsFn>;
  agentRegistry: AgentRegistry;
  credentialStore: CredentialStore;
  providerAccountManager: ProviderAccountManager;

  // Repo management
  repoStore: RepoStore;
  /** Warm a session for a repo (called after graduation). */
  warmSessionForRepo: (repoUrl: string) => Promise<void>;

  // Factories
  generateText: (prompt: string, cwd: string) => Promise<string>;
  getSharedRepoDir: (repoUrl: string) => string;

  // PR lifecycle
  prStatusPoller: PrStatusPoller;

  // Release lifecycle (docs/171)
  releaseStatusPoller: ReleaseStatusPoller;

  /**
   * Push a fresh rate-limit snapshot for any agent (from an
   * `agent_rate_limits` AgentEvent) into the subscription-limits badge.
   * Both Claude and Codex go through this single callback — Claude's data
   * comes from the CLI's `rate_limit_event` stream messages, Codex's from
   * the app-server `account/rateLimits/updated` notification. Optional
   * because test contexts and non-WS callers don't wire it. See
   * `index.ts` and the per-provider `setRateLimits()` methods.
   */
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
  ) => void;
  /**
   * Latest subscription-limits snapshot from the limits registry. Used to
   * classify agent result errors that upstream labels too generically.
   */
  getSubscriptionLimitsSnapshot?: () => SubscriptionLimitsMap;
  /**
   * docs/153 — fire-and-forget nudge to the orchestrator-owned Claude OAuth
   * refresher. Invoked from the session-level `auth_required` handler so that
   * a stale per-session token gets healed even if the next scheduled tick is
   * still minutes away. Single-flight inside the refresher; safe to call on
   * every auth_required without coordination. Optional — not wired in test
   * or local-runtime contexts. Kept as a direct ref for non-WS callers
   * (credentials sync); the WS-side `auth_required` handler routes through
   * the agent-keyed {@link onAgentAuthRequired} table. (docs/155)
   */
  nudgeClaudeOAuthRefresh?: () => void;
  /**
   * docs/155 — per-agent dispatch for the WS-level `auth_required` event.
   * Lets each backend register its own side effect (Claude: nudge the OAuth
   * refresher; Codex: a future device-flow restart) at app-DI time so the
   * listener's `auth_required` branch is agent-agnostic. Optional — no-op
   * if the agent has no registered hook.
   */
  onAgentAuthRequired?: (agentId: AgentId) => void;

  // Config
  workspaceDir: string;
  sessionsRoot: string;
  defaultAgentId: AgentId;
  /**
   * docs/138 — source-of-truth credentials root (e.g. `/credentials`). Used by
   * the first-turn hook to provision the pinned agent's credential subtree into
   * the session's private `<credentialsDir>/sessions/<id>` dir.
   */
  credentialsDir: string;
}
