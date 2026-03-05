import type { WsServerMessage, WsLogEntry, ClaudeContentBlockToolUse } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { SessionManager } from "../sessions.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { DeploymentManager } from "../deployment-manager.js";
import type { DeploymentStore } from "../deployment-store.js";
import type { FeatureManager } from "../features.js";
import type { UsageManager } from "../usage.js";
import type { AuthManager } from "../auth.js";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { RepoStore } from "../repo-store.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { AgentId, AgentProcess, TerminalProcess } from "../../shared/types.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, QueuedMessage, ChatMessageGroup } from "../session-runner.js";

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
  scheduleAutoPush: (git: GitManager) => void;
  clearLogBuffer: () => void;
}

/**
 * Per-session runner delegation.
 * Agent/claude state accessors delegate to the attached SessionRunner.
 */
export interface RunnerCtx {
  // Agent management
  agentFactory: (agentId: AgentId) => AgentProcess;
  getAgent: () => AgentProcess | null;
  setAgent: (a: AgentProcess | null) => void;
  getActiveAgentId: () => AgentId;
  setActiveAgentId: (id: AgentId) => void;
  getIsClaudeRunning: () => boolean;
  setIsClaudeRunning: (v: boolean) => void;
  getWasInterrupted: () => boolean;
  setWasInterrupted: (v: boolean) => void;

  // Accumulated turn state
  getTurnSummary: () => string;
  setTurnSummary: (s: string) => void;
  getAccumulatedText: () => string;
  setAccumulatedText: (s: string) => void;
  getAccumulatedToolUse: () => ClaudeContentBlockToolUse[];
  setAccumulatedToolUse: (blocks: ClaudeContentBlockToolUse[]) => void;

  // Per-turn message groups — each tool-result boundary starts a new group
  getChatMessageGroups: () => ChatMessageGroup[];
  setChatMessageGroups: (groups: ChatMessageGroup[]) => void;
  getNeedsNewMessageGroup: () => boolean;
  setNeedsNewMessageGroup: (v: boolean) => void;

  // Message queue
  getMessageQueue: () => QueuedMessage[];
  clearMessageQueue: () => void;

  // Terminal
  getTerminal: () => TerminalProcess | null;
  setTerminal: (t: TerminalProcess | null) => void;

  // Runner lifecycle
  /** Get the runner attached to this connection (if any). */
  getRunner: () => SessionRunnerInterface | null;
  /** Get the app-level runner registry. */
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
  deploymentManager: DeploymentManager;
  deploymentStore: DeploymentStore;
  featureManager: FeatureManager;
  usageManager: UsageManager;
  authManager: AuthManager;
  agentRegistry: AgentRegistry;
  credentialStore: CredentialStore;

  // Repo management
  repoStore: RepoStore;
  /** Warm a session for a repo (called after graduation). */
  warmSessionForRepo: (repoUrl: string, opts?: { withStandby?: boolean }) => void;

  // Factories
  createSessionDir: (title: string, opts?: { skipGitInit?: boolean }) => Promise<{ appSessionId: string; sessionDir: string }>;
  generateText: (prompt: string, cwd?: string) => Promise<string>;
  getSharedRepoDir: (repoUrl: string) => string;

  // PR lifecycle
  prStatusPoller: PrStatusPoller;

  // Config
  workspaceDir: string;
  sessionsRoot: string;
  defaultAgentId: AgentId;
}


