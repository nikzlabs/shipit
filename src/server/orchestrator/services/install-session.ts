import { safeSimpleGit } from "../../shared/git-hooks-guard.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { RepoStore } from "../repo-store.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { AgentId } from "../../shared/types.js";
import type { MarketplaceStore } from "../marketplace-store.js";
import type { ClaimSessionService } from "./claim-session.js";
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import { installPlugin, withWorkspaceLock } from "./marketplace.js";
import { agentCreatePr, activatePendingAutoMergeForPr } from "./github.js";
import { ServiceError } from "./types.js";

export interface InstallPluginAsSessionDeps {
  claimService: ClaimSessionService;
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  agentRegistry: AgentRegistry;
  marketplaceStore: MarketplaceStore;
  cacheRoot: string;
  githubAuthManager: GitHubAuthManager;
  sseBroadcast: (event: string, data: unknown) => void;
  defaultAgentId: AgentId;
  prStatusPoller?: PrStatusPoller;
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
}

export interface InstallPluginAsSessionOptions {
  repoUrl: string;
  marketplaceId: string;
  pluginName: string;
  agentId?: AgentId;
}

export interface InstallPluginAsSessionResult {
  sessionId: string;
  branch: string;
  pr: { number: number; url: string };
  installedDirs: string[];
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export async function installPluginAsSession(
  deps: InstallPluginAsSessionDeps,
  opts: InstallPluginAsSessionOptions,
): Promise<InstallPluginAsSessionResult> {
  const repoUrl = opts.repoUrl?.trim();
  if (!repoUrl) throw new ServiceError(400, "repoUrl is required");
  if (!opts.marketplaceId || !opts.pluginName) {
    throw new ServiceError(400, "marketplaceId and pluginName are required");
  }
  // Check auth before claiming: installation must produce a PR.
  if (!deps.githubAuthManager.authenticated) {
    throw new ServiceError(401, "Connect GitHub to install a skill as a pull request.");
  }

  const agentId = opts.agentId ?? deps.defaultAgentId;

  const claimed = await deps.claimService.claim(repoUrl, { forceFetch: true });
  const sessionId = claimed.sessionId;
  const workspaceDir = claimed.workspaceDir;

  let branchName: string;
  try {
    const currentBranch = (await safeSimpleGit(workspaceDir).raw(["branch", "--show-current"])).trim();
    const randomSlug = currentBranch.replace(/^shipit\//, "") || "skill";
    branchName = `shipit/install-${slugify(opts.pluginName)}-${randomSlug}`;
    if (currentBranch && currentBranch !== branchName) {
      await safeSimpleGit(workspaceDir).raw(["branch", "-m", currentBranch, branchName]);
    }
  } catch (err) {
    throw new ServiceError(500, `Failed to prepare install branch: ${String(err)}`);
  }

  // Session-row identity must match what's on disk before graduation.
  deps.sessionManager.setRemoteUrl(sessionId, repoUrl);
  deps.sessionManager.setBranch(sessionId, branchName);
  deps.sessionManager.setAgentId(sessionId, agentId);
  deps.sessionManager.setAgentPinned(sessionId);

  const git = deps.createGitManager(workspaceDir);
  const installResult = await withWorkspaceLock(workspaceDir, async () =>
    installPlugin({
      workspaceDir,
      agentId,
      marketplaceId: opts.marketplaceId,
      pluginName: opts.pluginName,
      cacheRoot: deps.cacheRoot,
      store: deps.marketplaceStore,
      git,
      agentRegistry: deps.agentRegistry,
    }),
  );

  // Create directly: this session has no viewer to trigger the lifecycle card.
  const title = `Install ${opts.pluginName} skill`;
  const skillsDirName = deps.agentRegistry.get(agentId)?.capabilities.skillsDirName ?? ".claude";
  const body = [
    `Installs the **${opts.pluginName}** skill from \`${opts.marketplaceId}\` into this repo's \`${skillsDirName}/skills/\`.`,
    "",
    "Opened automatically by ShipIt's skill installer. Merge to make the skill available in sessions on this repo.",
  ].join("\n");
  const pr = await agentCreatePr(git, deps.githubAuthManager, {
    title,
    body,
    labels: ["chore"],
    remoteUrl: repoUrl,
    sessionId,
  }).catch((err: unknown) => {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(500, `Failed to open pull request: ${String(err)}`);
  });

  // Explicit names prevent AI naming without chat context.
  const graduationDeps: GraduateSessionDeps = {
    sessionManager: deps.sessionManager,
    runnerRegistry: deps.runnerRegistry,
    repoStore: deps.repoStore,
    createGitManager: deps.createGitManager,
    sseBroadcast: deps.sseBroadcast,
    ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
    ...(deps.ensureAgentTokenFresh ? { ensureAgentTokenFresh: deps.ensureAgentTokenFresh } : {}),
  };
  graduateSession(graduationDeps, {
    sessionId,
    userText: title,
    agentId,
    explicitTitle: title,
    explicitBranch: branchName,
  });

  if (deps.prStatusPoller) {
    deps.prStatusPoller.trackSession(sessionId, repoUrl);
    await activatePendingAutoMergeForPr(
      deps.githubAuthManager,
      deps.prStatusPoller,
      sessionId,
      pr.url,
      pr.number,
    );
    void deps.prStatusPoller.forceRefreshSession(sessionId);
  }

  return {
    sessionId,
    branch: branchName,
    pr: { number: pr.number, url: pr.url },
    installedDirs: installResult.installedDirs,
  };
}
