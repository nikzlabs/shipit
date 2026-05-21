import type { WsServerMessage, WsLogEntry } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { SessionManager } from "../sessions.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { UsageManager } from "../usage.js";
import type { AuthManager } from "../auth.js";
import type { CodexAuthManager } from "../codex-auth.js";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { RepoStore } from "../repo-store.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { AgentId, AgentProcess } from "../../shared/types.js";
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
  codexAuthManager: CodexAuthManager;
  agentRegistry: AgentRegistry;
  credentialStore: CredentialStore;

  // Repo management
  repoStore: RepoStore;
  /** Warm a session for a repo (called after graduation). */
  warmSessionForRepo: (repoUrl: string, opts?: { withStandby?: boolean }) => Promise<void>;

  // Factories
  generateText: (prompt: string, cwd: string) => Promise<string>;
  getSharedRepoDir: (repoUrl: string) => string;

  // PR lifecycle
  prStatusPoller: PrStatusPoller;

  /**
   * Push a Codex rate-limit snapshot (from an `agent_rate_limits` AgentEvent)
   * into the subscription-limits badge. Optional because test contexts and
   * non-WS callers don't wire it. See index.ts / `CodexLimitsProvider`.
   */
  recordCodexRateLimits?: (
    session: { usedPct: number; resetAt: string } | null,
    weekly: { usedPct: number; resetAt: string } | null,
  ) => void;

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

