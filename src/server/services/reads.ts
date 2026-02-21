/**
 * Read service functions — all Phase 1 GET endpoint logic.
 *
 * These functions are stateless and accept explicit parameters (managers,
 * session IDs) instead of HandlerContext.
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { UsageManager } from "../usage.js";
import type { FeatureManager } from "../features.js";
import type { ThreadManager } from "../threads.js";
import type { DeploymentManager } from "../deployment-manager.js";
import type { DeploymentStore } from "../deployment-store.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo, FileDiff } from "../types.js";
import type { AgentId } from "../agents/agent-process.js";
import { GitManager as GitManagerClass } from "../git.js";
import { scanFileTree } from "../file-tree.js";
import { findMarkdownFiles } from "../markdown.js";
import { listTemplates } from "../templates.js";
import type { AgentInfo, GlobalSettings, GitHubStatus, BootstrapData } from "./types.js";
import { ServiceError } from "./types.js";

/**
 * List all sessions, lazily populating remote URLs for sessions that have
 * a workspace but no cached URL.
 */
export async function listSessions(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
): Promise<SessionInfo[]> {
  const sessions = sessionManager.list();
  await Promise.all(
    sessions.map(async (session) => {
      if (session.workspaceDir && !session.remoteUrl) {
        try {
          const git = createGitManager(session.workspaceDir);
          const remotes = await git.getRemotes();
          const origin = remotes.find((r) => r.name === "origin");
          if (origin?.url) {
            sessionManager.setRemoteUrl(session.id, origin.url);
            session.remoteUrl = origin.url;
          }
        } catch {
          // Workspace may not exist or not be a git repo — skip
        }
      }
    })
  );
  return sessions;
}

/** Map agent registry entries to the client-facing agent info shape. */
export function listAgents(agentRegistry: AgentRegistry): AgentInfo[] {
  return agentRegistry.list().map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.installed,
    authConfigured: a.authConfigured,
    models: a.capabilities.models,
  }));
}

/** Get global settings (git identity, system prompt, agents). */
export async function getGlobalSettings(
  credentialStore: CredentialStore,
  agentRegistry: AgentRegistry,
  defaultAgentId: AgentId,
  workspaceDir: string,
): Promise<GlobalSettings> {
  const stored = credentialStore.getGitIdentity();
  const gitIdentity = stored
    ? { name: stored.name, email: stored.email }
    : { name: "", email: "" };

  let systemPrompt = "";
  try {
    systemPrompt = (
      await fs.readFile(
        path.join(workspaceDir, ".shipit", "system-prompt.md"),
        "utf-8",
      )
    ).trim();
  } catch {
    /* no file */
  }

  const agents = listAgents(agentRegistry);
  return { gitIdentity, systemPrompt, agents, defaultAgentId };
}

/** Get GitHub authentication status. */
export function getGitHubStatus(githubAuthManager: GitHubAuthManager): GitHubStatus {
  return githubAuthManager.getStatus();
}

/** Get user's GitHub repos (empty array if not authenticated). */
export async function getGitHubRepos(
  githubAuthManager: GitHubAuthManager,
): Promise<Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>> {
  if (!githubAuthManager.authenticated) return [];
  return githubAuthManager.listUserRepos();
}

/** Get all data needed for the initial bootstrap. */
export async function getBootstrapData(deps: {
  sessionManager: SessionManager;
  createGitManager: (dir: string) => GitManager;
  agentRegistry: AgentRegistry;
  githubAuthManager: GitHubAuthManager;
  credentialStore: CredentialStore;
  defaultAgentId: AgentId;
  workspaceDir: string;
}): Promise<BootstrapData> {
  const [sessions, settings, githubRepos] = await Promise.all([
    listSessions(deps.sessionManager, deps.createGitManager),
    getGlobalSettings(deps.credentialStore, deps.agentRegistry, deps.defaultAgentId, deps.workspaceDir),
    getGitHubRepos(deps.githubAuthManager),
  ]);

  return {
    sessions,
    agents: settings.agents,
    defaultAgentId: deps.defaultAgentId,
    templates: listTemplates(),
    githubStatus: getGitHubStatus(deps.githubAuthManager),
    githubRepos,
    settings,
  };
}

/** Get the session status (running, queue length) from the runner registry. */
export function getSessionStatus(
  runnerRegistry: SessionRunnerRegistry,
  sessionId: string,
): { running: boolean; queueLength: number } {
  const runner = runnerRegistry.get(sessionId);
  return {
    running: runner?.running ?? false,
    queueLength: runner?.queueLength ?? 0,
  };
}

/** Get usage stats. */
export function getUsageStats(usageManager: UsageManager) {
  return usageManager.getStats();
}

/** List features from the feature manager. */
export async function listFeatures(featureManager: FeatureManager) {
  return featureManager.list();
}

/** Get git log for a session. */
export async function getGitLog(git: GitManager) {
  return git.log();
}

/** Get file tree for a directory. */
export async function getFileTree(dir: string) {
  return scanFileTree(dir);
}

/** Get file content with safety checks (path traversal, binary, size). */
export async function getFileContent(
  dir: string,
  filePath: string,
): Promise<{ content: string; isBinary?: boolean }> {
  const safePath = path.resolve(dir, filePath);
  if (!safePath.startsWith(dir + "/")) {
    throw new ServiceError(400, "Invalid path");
  }
  const stat = await fs.stat(safePath);
  if (stat.size > 1_048_576) {
    return {
      content: `File is too large to display (${(stat.size / 1_048_576).toFixed(1)} MB). Maximum supported size is 1 MB.`,
      isBinary: true,
    };
  }
  const buf = await fs.readFile(safePath);
  if (buf.includes(0)) {
    return { content: "Binary file — cannot display.", isBinary: true };
  }
  return { content: buf.toString("utf-8") };
}

/** List markdown documentation files. */
export async function listDocs(dir: string) {
  return findMarkdownFiles(dir);
}

/** Get a single doc file's content. */
export async function getDocContent(
  dir: string,
  docPath: string,
): Promise<string> {
  const safePath = path.resolve(dir, docPath);
  if (!safePath.startsWith(dir + "/")) {
    throw new ServiceError(400, "Invalid path");
  }
  return fs.readFile(safePath, "utf-8");
}

/** Get git diff between two commits (file list with name/status). */
export async function getGitDiffNameStatus(git: GitManager, from: string, to: string) {
  return git.diffNameStatus(from, to);
}

/** Get git remotes. */
export async function getGitRemotes(git: GitManager) {
  return git.getRemotes();
}

/** Get git branches (current + remote). */
export async function getGitBranches(git: GitManager) {
  const current = await git.getCurrentBranch();
  let remote: string[] = [];
  try {
    remote = await git.listRemoteBranches();
  } catch {
    // No remote branches — that's fine
  }
  return { current, remote };
}

/** Get deploy history for a session. */
export function getDeployHistory(deploymentStore: DeploymentStore, sessionId: string) {
  return deploymentStore.getHistory(sessionId);
}

/** Get deploy targets list. */
export function getDeployTargets(deploymentManager: DeploymentManager) {
  return deploymentManager.getTargets();
}

/** Get project deploy config for all targets. */
export function getProjectSettings(
  deploymentManager: DeploymentManager,
  deploymentStore: DeploymentStore,
  sessionId: string,
) {
  const targets = deploymentManager.getTargets();
  const deployConfig: Record<string, { configured: boolean; projectName?: string }> = {};
  for (const t of targets) {
    const config = deploymentStore.loadConfig(sessionId, t.id);
    deployConfig[t.id] = config
      ? { configured: true, projectName: config.projectName }
      : { configured: false };
  }
  return deployConfig;
}

/** Get deploy setup (targets + project settings combined). */
export function getDeploySetup(
  deploymentManager: DeploymentManager,
  deploymentStore: DeploymentStore,
  sessionId: string,
) {
  return {
    targets: getDeployTargets(deploymentManager),
    projectSettings: getProjectSettings(deploymentManager, deploymentStore, sessionId),
  };
}

/** Get workspace state (git log + file tree) for a session. */
export async function getWorkspaceState(
  git: GitManager,
  dir: string,
): Promise<{ gitLog: Awaited<ReturnType<typeof getGitLog>>; fileTree: Awaited<ReturnType<typeof getFileTree>> }> {
  const [gitLog, fileTree] = await Promise.all([
    getGitLog(git),
    getFileTree(dir),
  ]);
  return { gitLog, fileTree };
}

/** Get chat messages for a session (read-only, no activation side effects). */
export function getChatHistory(
  chatHistoryManager: { load: (sessionId: string) => unknown[] },
  sessionId: string,
) {
  return chatHistoryManager.load(sessionId);
}

/** Get threads for a session. */
export function listThreads(threadManager: ThreadManager, sessionId: string) {
  return threadManager.listThreads(sessionId);
}

/** Get worktrees (sibling sessions sharing the same repo). */
export function listWorktrees(
  sessionManager: SessionManager,
  sessionId: string,
): Array<{ sessionId: string; branch: string; path: string }> {
  const session = sessionManager.get(sessionId);
  const siblings = session?.remoteUrl
    ? sessionManager.findAllByRemoteUrl(session.remoteUrl)
    : [session].filter(Boolean) as SessionInfo[];

  const worktrees: Array<{ sessionId: string; branch: string; path: string }> = [];
  for (const s of siblings) {
    if (s.workspaceDir && s.branch) {
      worktrees.push({ sessionId: s.id, branch: s.branch, path: s.workspaceDir });
    }
  }
  return worktrees;
}

/** Search GitHub repos. */
export async function searchGitHubRepos(
  githubAuthManager: GitHubAuthManager,
  query: string,
) {
  if (!query || query.length < 2) return [];
  return githubAuthManager.searchRepos(query);
}

/** Get the full turn diff between two commits (file contents + stats). */
export async function getTurnDiff(
  git: GitManager,
  fromCommit: string,
  toCommit: string,
): Promise<{
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}> {
  const changedFiles = await git.diffNameStatus(fromCommit, toCommit);
  const diffSummary = await git.diffSummary();

  const statsMap = new Map<string, { insertions: number; deletions: number }>();
  for (const f of diffSummary) {
    statsMap.set(f.file, { insertions: f.insertions, deletions: f.deletions });
  }

  const files: FileDiff[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const entry of changedFiles) {
    const stats = statsMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
    const isBinary = stats.insertions === 0 && stats.deletions === 0 && entry.status !== "D";

    let status: FileDiff["status"];
    switch (entry.status) {
      case "A": status = "added"; break;
      case "D": status = "deleted"; break;
      case "R": status = "renamed"; break;
      default: status = "modified"; break;
    }

    let oldContent = "";
    let newContent = "";

    if (!isBinary) {
      if (status === "deleted") {
        oldContent = await git.getFileAtCommit(fromCommit, entry.path);
      } else if (status === "added") {
        newContent = await git.getFileAtCommit(toCommit, entry.path);
      } else if (status === "renamed") {
        oldContent = await git.getFileAtCommit(fromCommit, entry.oldPath ?? entry.path);
        newContent = await git.getFileAtCommit(toCommit, entry.path);
      } else {
        oldContent = await git.getFileAtCommit(fromCommit, entry.path);
        newContent = await git.getFileAtCommit(toCommit, entry.path);
      }
    }

    totalInsertions += stats.insertions;
    totalDeletions += stats.deletions;

    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status,
      insertions: stats.insertions,
      deletions: stats.deletions,
      binary: isBinary,
      oldContent,
      newContent,
    });
  }

  return {
    fromCommit,
    toCommit,
    files,
    stats: { totalInsertions, totalDeletions, filesChanged: files.length },
  };
}

/** Get PR status for a session (returns null if no PR or not authenticated). */
export async function getPrStatus(
  githubAuthManager: GitHubAuthManager,
  git: GitManager,
) {
  if (!githubAuthManager.authenticated) return null;

  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return null;

  const parsed = GitManagerClass.parseGitHubRemote(origin.url);
  if (!parsed) return null;

  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);
  if (!pr) return null;

  const stats = await git.diffStatVsBranch(pr.base);
  const checks = await githubAuthManager.getCheckStatus(parsed.owner, parsed.repo, head);

  return {
    url: pr.url,
    number: pr.number,
    title: pr.title,
    baseBranch: pr.base,
    headBranch: head,
    insertions: stats.insertions,
    deletions: stats.deletions,
    checks,
    autoMergeEnabled: false,
    mergeable: true,
  };
}
