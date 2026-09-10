import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { GitManager } from "../shared/git.js";
import type { RepoGit } from "./repo-git.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { CredentialStore } from "./credential-store.js";
import type { AgentRegistry } from "../shared/agent-registry.js";
import type {
  AgentId,
  AgentProcess,
  LimitsRefreshResult,
  EgressEnforcementStatus,
} from "../shared/types.js";
import type { ReconcileEgressOutcome } from "./services/reconcile-session-egress.js";
import type { UsageManager } from "./usage.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { AgentMergeClaimStore } from "./agent-merge-claims.js";
import type { SessionContainerManager } from "./session-container.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { AuthManager } from "./agents/claude/auth-manager.js";
import type { CodexAuthManager } from "./agents/codex/auth-manager.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import type { PrepareRunParamsFn } from "./agent-run-params-prep.js";
import type { PrStatusPoller } from "./pr-status-poller.js";
import type { ReleaseStatusPoller } from "./release-status-poller.js";
import type { MergeWatchManager } from "./merge-watch.js";
import type { DatabaseManager } from "../shared/database.js";
import type { ServiceManager } from "./service-manager.js";
import type { LogRingEntry } from "../shared/types.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import type { SessionLoopDetector } from "./loop-detector.js";
import type { RuntimeMode } from "../shared/types.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import type { ModelRunner } from "./services/redaction.js";
import type { LogStoreReader } from "./services/host-session-logs.js";

import { ServiceError } from "./services/index.js";

import { registerContainerOriginGuard } from "./api-container-guard.js";
import { registerBootstrapRoutes } from "./api-routes-bootstrap.js";
import { registerContainerRoutes } from "./api-routes-container.js";
import { registerHostRoutes } from "./api-routes-host.js";
import { registerSourceRoutes } from "./api-routes-source.js";
import { registerHostSessionRoutes } from "./api-routes-host-sessions.js";
import { registerFileRoutes } from "./api-routes-files.js";
import { registerGitRoutes } from "./api-routes-git.js";
import { registerSessionCrudRoutes } from "./api-routes-session-crud.js";
import { registerSessionReposRoutes } from "./api-routes-session-repos.js";
import { registerSessionSpawnRoutes } from "./api-routes-session-spawn.js";
import { registerLazyBodyRoutes } from "./api-routes-lazy-bodies.js";
import { createClaimSessionService, type ClaimSessionService } from "./services/claim-session.js";
import { registerPreviewRoutes } from "./api-routes-preview.js";
import { registerGitHubRoutes } from "./api-routes-github.js";
import { registerSecretsRoutes } from "./api-routes-secrets.js";
import { registerMcpRoutes } from "./api-routes-mcp.js";
import { registerReviewRoutes } from "./api-routes-reviews.js";
import { registerUpdateRoutes } from "./api-routes-updates.js";
import { registerAgentRoutes } from "./api-routes-agent.js";
import { registerLimitsRoutes } from "./api-routes-limits.js";
import { registerMarketplaceRoutes } from "./api-routes-marketplace.js";
import { registerVoiceRoutes } from "./api-routes-voice.js";
import { registerBugReportRoutes } from "./api-routes-bug-report.js";
import { registerProposeActionsRoutes } from "./api-routes-propose-actions.js";
import { registerEgressRoutes } from "./api-routes-egress.js";
import { registerIssueRoutes } from "./api-routes-issues.js";
import { registerPluginRepoRoutes } from "./api-routes-plugin-repos.js";
import type { PluginRefreshResult } from "./services/plugin-refresh.js";
import type { PluginCliRequest, PluginCliResult } from "./plugin-cli-run.js";
import type { SecretStore } from "./secret-store.js";
import type { EgressAllowlistStore } from "./egress-allowlist-store.js";
import type { FileReviewStore } from "./review-store.js";
import type { PresentStore } from "./present-store.js";
import type { MarketplaceStore } from "./marketplace-store.js";
import type { GenerateText } from "./non-turn-model.js";

export interface ApiDeps {
  sessionManager: SessionManager;
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  createRepoGit: (dir: string) => RepoGit;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  providerAccountManager: ProviderAccountManager;
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  defaultAgentId: AgentId;
  workspaceDir: string;
  stateDir?: string;
  runtimeMode?: RuntimeMode;
  credentialsDir?: string;
  usageManager: UsageManager;
  runnerRegistry: SessionRunnerRegistry;
  agentMergeClaims?: AgentMergeClaimStore;
  agentMergeExecutor?: { tick(): Promise<void> };
  // Required keys with undefined values catch omitted runtime wiring at compile time.
  refreshPluginReposForSession: ((
    sessionId: string,
    workspaceDir: string,
    repoName?: string,
    force?: boolean,
  ) => Promise<PluginRefreshResult>) | undefined;
  runPluginCommandForSession: ((
    sessionId: string,
    workspaceDir: string,
    request: PluginCliRequest,
  ) => Promise<PluginCliResult>) | undefined;
  cancelAutoPush?: (sessionId: string) => void;
  scheduleAutoPush?: (git: GitManager, sessionId?: string) => void;
  chatHistoryManager: ChatHistoryManager;
  authManager: AuthManager;
  codexAuthManager: CodexAuthManager;
  authManagers: Map<LoginIntegrationId, AgentAuthManager>;
  runParamsPreps: Map<AgentId, PrepareRunParamsFn>;
  broadcastLog: (sessionId: string, source: "stderr" | "stdout" | "server" | "preview" | "install", text: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;
  refreshSubscriptionLimits?: (
    modeKey: string,
    reason: "manual" | "seed",
    routeId?: string,
  ) => Promise<LimitsRefreshResult[]>;
  forgetSubscriptionLimits?: (modeKey: string, routeId: string) => void;
  recordAgentRateLimits?: (
    agentId: AgentId,
    session: { usedPct: number | null; resetAt: string } | null,
    weekly: { usedPct: number | null; resetAt: string } | null,
    sessionId?: string,
    routeId?: string,
  ) => void;
  bugReportModelRunner?: ModelRunner;
  getSharedRepoDir: (repoUrl: string) => string;
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  generateText: GenerateText;
  sessionsRoot: string;
  warmSessionForRepo?: (repoUrl: string) => Promise<void>;
  waitForWarmSession?: (repoUrl: string) => Promise<void> | undefined;
  shouldSkipClaimFetch?: (repoUrl: string) => boolean;
  createSessionDirFull: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  containerManager?: SessionContainerManager;
  prStatusPoller?: PrStatusPoller;
  releaseStatusPoller?: ReleaseStatusPoller;
  mergeWatchManager?: MergeWatchManager;
  databaseManager?: DatabaseManager;
  secretStore?: SecretStore;
  egressAllowlistStore?: EgressAllowlistStore;
  egressEnforcementActive?: boolean;
  egressEnforcementStatus?: EgressEnforcementStatus;
  reconcileSessionEgress?: (sessionId: string) => Promise<ReconcileEgressOutcome>;
  egressDnsControlDeployed?: boolean;
  reviewStore?: FileReviewStore;
  presentStore?: PresentStore;
  marketplaceStore?: MarketplaceStore;
  claimSessionService?: ClaimSessionService;
  serviceManagers?: Map<string, ServiceManager>;
  composeStopPromises?: Map<string, Promise<void>>;
  pruneSessionVolumes?: (sessionId: string) => Promise<void>;
  getLogBuffer?: (sessionId: string) => LogRingEntry[];
  removeSessionLogs?: (sessionId: string) => void;
  logStore: LogStoreReader | undefined;
  oomBreaker?: SessionOomCircuitBreaker;
  loopDetector?: SessionLoopDetector;
  agentFactory?: (agentId: AgentId) => AgentProcess;
  mcpOAuthFetchImpl?: typeof fetch;
  trackerFetchImpl?: typeof fetch;
}

export function resolveSessionDir(
  sessionManager: SessionManager,
  sessionId: string,
  reply: FastifyReply,
): string | null {
  const session = sessionManager.get(sessionId);
  if (!session) {
    reply.code(404).send({ error: "Session not found" });
    return null;
  }
  if (!session.workspaceDir) {
    reply.code(404).send({ error: "Session has no workspace directory" });
    return null;
  }
  return session.workspaceDir;
}

export async function registerApiRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  app.addHook("onError", (_request: FastifyRequest, reply: FastifyReply, error: Error, done: () => void) => {
    if (error instanceof ServiceError) {
      reply.code(error.statusCode).send({ error: error.message });
    }
    done();
  });

  // Register first so the guard observes every route's containerAccessible setting.
  registerContainerOriginGuard(app, { containerManager: deps.containerManager });

  // Share the claim service: its per-repo lock lives in the instance's closure.
  const claimSessionService = deps.claimSessionService ?? createClaimSessionService({
    sessionManager: deps.sessionManager,
    repoStore: deps.repoStore,
    createGitManager: deps.createGitManager,
    createRepoGit: deps.createRepoGit,
    githubAuthManager: deps.githubAuthManager,
    getSharedRepoDir: deps.getSharedRepoDir,
    createSessionDirFull: deps.createSessionDirFull,
    sseBroadcast: deps.sseBroadcast,
    ...(deps.warmSessionForRepo ? { warmSessionForRepo: deps.warmSessionForRepo } : {}),
    ...(deps.waitForWarmSession ? { waitForWarmSession: deps.waitForWarmSession } : {}),
    ...(deps.shouldSkipClaimFetch ? { shouldSkipClaimFetch: deps.shouldSkipClaimFetch } : {}),
    ...(deps.containerManager ? { containerManager: deps.containerManager } : {}),
    ...(deps.egressAllowlistStore ? { egressAllowlistStore: deps.egressAllowlistStore } : {}),
  });
  const deps2: ApiDeps = { ...deps, claimSessionService };

  await registerBootstrapRoutes(app, deps2);
  await registerFileRoutes(app, deps2);
  await registerGitRoutes(app, deps2);
  await registerSessionCrudRoutes(app, deps2);
  await registerSessionReposRoutes(app, deps2);
  await registerSessionSpawnRoutes(app, deps2);
  registerLazyBodyRoutes(app, deps2);
  await registerContainerRoutes(app, deps);
  await registerHostRoutes(app, deps);
  await registerSourceRoutes(app, deps);
  await registerHostSessionRoutes(app, deps);
  await registerPreviewRoutes(app, deps);
  await registerGitHubRoutes(app, deps);
  if (deps.reviewStore) {
    await registerReviewRoutes(app, deps);
  }
  if (deps.secretStore) {
    const serviceManagers: Map<string, ServiceManager> =
      deps.serviceManagers ?? new Map<string, ServiceManager>();
    await registerSecretsRoutes(app, {
      secretStore: deps.secretStore,
      sessionManager: deps.sessionManager,
      serviceManagers,
    });
  }
  await registerUpdateRoutes(app);
  await registerAgentRoutes(app, deps);
  await registerVoiceRoutes(app, deps);
  await registerBugReportRoutes(app, deps);
  await registerProposeActionsRoutes(app, deps);
  await registerEgressRoutes(app, deps);
  await registerIssueRoutes(app, deps);
  await registerPluginRepoRoutes(app, deps);
  await registerLimitsRoutes(app, deps);

  if (deps.marketplaceStore) {
    await registerMarketplaceRoutes(app, {
      ...deps2,
      marketplaceStore: deps.marketplaceStore,
      stateDir: deps.stateDir ?? deps.workspaceDir,
    });
  }

  await registerMcpRoutes(app, {
    credentialStore: deps.credentialStore,
    runnerRegistry: deps.runnerRegistry,
    serviceManagers: deps.serviceManagers ?? new Map<string, ServiceManager>(),
    ...(deps.mcpOAuthFetchImpl !== undefined
      ? { oauthFetchImpl: deps.mcpOAuthFetchImpl }
      : {}),
  });
}
