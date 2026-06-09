/**
 * Install-as-session service (docs/149 — skill install UX, 2026-06-09 revision).
 *
 * Installing a skill is a repo change, so it runs in its own dedicated session
 * on a fresh branch and opens a PR — rather than mutating whatever session the
 * user happens to be in. The current session is never touched.
 *
 * Flow (no agent turn ever runs):
 *   1. Claim a fresh repo-backed workspace for the selected repo (the same
 *      warm-pool-aware path the home screen + agent-spawn use).
 *   2. Rename the claim branch to a readable `shipit/install-<plugin>-<slug>`.
 *   3. Run `installPlugin()` in that workspace — writes SKILL.md + marker and a
 *      path-scoped LOCAL commit.
 *   4. Open the PR via `agentCreatePr()` directly and unconditionally — it
 *      pushes the branch AND creates the PR with a fixed title/body. We do NOT
 *      use `emitPrLifecycleAfterCommit` / the `autoCreatePr` toggle: that path
 *      is viewer-gated and this freshly-spawned session has no WS viewer, so it
 *      would silently produce no PR.
 *   5. Graduate the session so it appears in the sidebar, and track the PR.
 *
 * GitHub auth is required up front: the whole point is to open a PR, so we fail
 * fast with a clear message before claiming a workspace if it's missing.
 */

import simpleGit from "simple-git";
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
  /** Agent the install targets. Defaults to `defaultAgentId` (Claude in v1). */
  agentId?: AgentId;
}

export interface InstallPluginAsSessionResult {
  sessionId: string;
  branch: string;
  pr: { number: number; url: string };
  installedDirs: string[];
}

/** Lowercase kebab slug for a branch segment. */
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
  // Fail fast before claiming a workspace — the install only makes sense if we
  // can open a PR for it.
  if (!deps.githubAuthManager.authenticated) {
    throw new ServiceError(401, "Connect GitHub to install a skill as a pull request.");
  }

  const agentId = opts.agentId ?? deps.defaultAgentId;

  // 1. Claim a fresh workspace for the repo. forceFetch so the branch is cut
  //    off the real current default branch (matches the agent-spawn path).
  const claimed = await deps.claimService.claim(repoUrl, { forceFetch: true });
  const sessionId = claimed.sessionId;
  const workspaceDir = claimed.workspaceDir;

  // 2. Rename the claim branch (`shipit/<rand>`) to a readable install branch.
  let branchName: string;
  try {
    const currentBranch = (await simpleGit(workspaceDir).raw(["branch", "--show-current"])).trim();
    const randomSlug = currentBranch.replace(/^shipit\//, "") || "skill";
    branchName = `shipit/install-${slugify(opts.pluginName)}-${randomSlug}`;
    if (currentBranch && currentBranch !== branchName) {
      await simpleGit(workspaceDir).raw(["branch", "-m", currentBranch, branchName]);
    }
  } catch (err) {
    throw new ServiceError(500, `Failed to prepare install branch: ${String(err)}`);
  }

  // Session-row identity must match what's on disk before graduation.
  deps.sessionManager.setRemoteUrl(sessionId, repoUrl);
  deps.sessionManager.setBranch(sessionId, branchName);
  deps.sessionManager.setAgentId(sessionId, agentId);
  deps.sessionManager.setAgentPinned(sessionId);

  // 3. Write + local commit. The workspace is fresh, but hold the lock for
  //    consistency with the rest of the install paths.
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

  // 4. Push + open the PR directly (NOT via the viewer-gated lifecycle card).
  const title = `Install ${opts.pluginName} skill`;
  const body = [
    `Installs the **${opts.pluginName}** skill from \`${opts.marketplaceId}\` into this repo's \`.claude/skills/\`.`,
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
    // Surface PR failures as the install failing — the session was spawned but
    // there's no PR to review, which defeats the flow.
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(500, `Failed to open pull request: ${String(err)}`);
  });

  // 5. Graduate so the session shows in the sidebar. Explicit title + branch so
  //    AI naming doesn't rename either (it has no chat context to name from).
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

  // Track the PR so its status surfaces in the new session's PR card.
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
