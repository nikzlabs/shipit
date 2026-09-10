import type { LoginIntegrationId } from "../../shared/catalogue/types.js";
import type { WsServerMessage, LogSource } from "../../shared/types.js";
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
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import type { SessionContainerManager } from "../session-container.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { ReleaseStatusPoller } from "../release-status-poller.js";
import type { AgentId, AgentProcess } from "../../shared/types.js";
import type { SubscriptionLimitsMap } from "../../shared/types.js";
import type { SessionRunnerInterface, SessionRunnerRegistry, QueuedMessage } from "../session-runner.js";
import type { GenerateText } from "../non-turn-model.js";

export type { QueuedMessage };

export interface ConnectionCtx {
  send: (msg: WsServerMessage) => void;
  broadcastLog: (source: LogSource, text: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;

  getActiveDir: () => string;
  getActiveGitManager: () => GitManager;
  getActiveAppSessionId: () => string | undefined;
  setActiveAppSessionId: (id: string | undefined) => void;
  getActiveSessionDir: () => string | null;
  setActiveSessionDir: (dir: string | null) => void;
  activateSession: (sessionId: string) => void | Promise<void>;

  checkGitIdentity: (dir: string) => void;
  readSystemPrompt: () => Promise<string | undefined>;
  scheduleAutoPush: (git: GitManager, sessionId?: string) => void;
  clearLogBuffer: () => void;
}

export interface RunnerCtx {
  agentFactory: (agentId: AgentId) => AgentProcess;

  getActiveAgentId: () => AgentId;
  setActiveAgentId: (id: AgentId) => void;
  getSelectedModel: () => string | undefined;
  setSelectedModel: (model: string | undefined) => void;
  getSelectedReasoning: () => string | undefined;
  setSelectedReasoning: (effort: string | undefined) => void;

  /** Connection-scoped; use resolveRunner(ctx) to survive disconnects. */
  getRunner: () => SessionRunnerInterface | null;
  getRunnerRegistry: () => SessionRunnerRegistry;
  attachToRunner: (runner: SessionRunnerInterface) => void;
  detachFromRunner: () => void;
}

export interface AppCtx {
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  createGitManager: (dir: string) => GitManager;
  createRepoGit: (dir: string) => RepoGit;
  githubAuthManager: GitHubAuthManager;
  usageManager: UsageManager;
  authManager: AuthManager;
  authManagers: Map<LoginIntegrationId, AgentAuthManager>;
  runParamsPreps?: Map<AgentId, PrepareRunParamsFn>;
  agentRegistry: AgentRegistry;
  credentialStore: CredentialStore;
  providerAccountManager: ProviderAccountManager;
  trackerFetchImpl?: typeof fetch;

  repoStore: RepoStore;
  warmSessionForRepo: (repoUrl: string) => Promise<void>;
  egressAllowlistStore?: EgressAllowlistStore;
  containerManager?: SessionContainerManager;

  generateText: GenerateText;
  getSharedRepoDir: (repoUrl: string) => string;
  prStatusPoller: PrStatusPoller;
  releaseStatusPoller: ReleaseStatusPoller;

  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
    sessionId?: string,
    /** Consults can use a different credential from the owning session. */
    routeId?: string,
  ) => void;
  getSubscriptionLimitsSnapshot?: () => SubscriptionLimitsMap;
  /** until is epoch milliseconds. */
  markSessionAccountExhausted?: (sessionId: string, until: number, routeId?: string) => void;
  nudgeClaudeOAuthRefresh?: () => void;
  onAgentAuthRequired?: (agentId: AgentId) => void;
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  removeSessionLogs?: (sessionId: string) => void;

  workspaceDir: string;
  sessionsRoot: string;
  defaultAgentId: AgentId;
  credentialsDir: string;
}
