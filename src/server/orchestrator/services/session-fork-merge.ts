import fs from "node:fs/promises";
import path from "node:path";
import { safeSimpleGit } from "../../shared/git-hooks-guard.js";
import {
  type GitRemoteCredentialResolver,
  credentialledGit,
  resolveTreeRemoteCredential,
  withPreemptiveAuthFallback,
} from "../../shared/git-remote-credential.js";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { SessionInfo } from "../../shared/types.js";
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";
import { chownTreeToSessionWorker, handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { allocateAndSealSessionDir } from "../session-uid-allocator.js";
import {
  buildLfsUnresolvedAgentNotice,
  materializeLfsWithWarning,
  restoreLfsAfterTreeRewrite,
} from "../git-lfs.js";
import { stripRemoteUrlCredentials } from "../git-utils.js";
import { resolveGitTreeUid } from "../../shared/git-tree-uid.js";

async function readOriginHead(dir: string): Promise<string | null> {
  try {
    const ref = (await safeSimpleGit(dir).raw(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
    return ref || null;
  } catch {
    return null;
  }
}

// Prefer the cache: older forks can have their parent's session branch as origin/HEAD.
// Read the raw ref so an absent cache cannot replace a valid parent value with "main".
async function resolveForkOriginHead(parentDir: string, bareCacheDir: string | null): Promise<string | null> {
  if (bareCacheDir) {
    try {
      const head = (await safeSimpleGit(bareCacheDir).raw(["symbolic-ref", "HEAD"])).trim();
      const match = /^refs\/heads\/(.+)$/.exec(head);
      if (match) return `refs/remotes/origin/${match[1]}`;
    } catch {
      // Fall back to the parent when the cache is unavailable.
    }
  }
  return readOriginHead(parentDir);
}

// Local clone sets origin/HEAD from the source's checked-out branch; fetch --prune
// does not correct it. Keep a known default even if its tracking ref is missing.
async function inheritOriginHead(parentDir: string, forkDir: string, bareCacheDir: string | null): Promise<void> {
  const originHead = await resolveForkOriginHead(parentDir, bareCacheDir);
  try {
    await safeSimpleGit(forkDir).raw(
      originHead
        ? ["symbolic-ref", "refs/remotes/origin/HEAD", originHead]
        : ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
    );
  } catch (err) {
    console.warn("[git] fork: could not align origin/HEAD (non-fatal):", String(err));
  }
}

export interface ForkReportSinks {
  warn?: (message: string) => void;
  noticeForAgent?: (sessionId: string, notice: string) => void;
}

export function forkReportSinks(deps: {
  sessionManager: Pick<SessionManager, "appendPendingAgentNotice">;
  sseBroadcast: (event: string, data: unknown) => void;
}): ForkReportSinks {
  return {
    warn: (message) => {
      console.warn(`[fork] ${message}`);
      deps.sseBroadcast("error", { message });
    },
    noticeForAgent: (sessionId, notice) => {
      // Preserve any pending branch-movement notice alongside the LFS warning.
      deps.sessionManager.appendPendingAgentNotice(sessionId, notice);
    },
  };
}

export async function forkSession(
  sessionManager: SessionManager,
  _createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (repoUrl: string) => string,
  sessionsRoot: string,
  githubAuthManager: { authenticated: boolean; configureGitCredentials: (dir: string) => void },
  _threadManager: { init: (sessionId: string) => void },
  activeSessionId: string,
  activeSessionDir: string,
  branchName: string,
  startPoint: string | undefined,
  title: string | undefined,
  graduationDeps: GraduateSessionDeps,
  resolveRemoteCredential?: GitRemoteCredentialResolver,
  report: ForkReportSinks = {},
): Promise<{ session: SessionInfo; parentSessionId: string; sessions: SessionInfo[] }> {
  const trimmed = branchName.trim();
  if (!trimmed) throw new ServiceError(400, "Branch name is required");
  if (/[\s~^:?*[\\]/.test(trimmed) || trimmed.includes("..")) {
    throw new ServiceError(400, "Invalid branch name");
  }

  const activeSession = sessionManager.get(activeSessionId);

  const crypto = await import("node:crypto");
  const newSessionId = crypto.randomUUID();
  const newSessionDir = path.join(sessionsRoot, newSessionId);
  const newWorkspaceDir = path.join(newSessionDir, "workspace");

  // Clone the session, since startPoint may not have reached the bare cache.
  // Give the destination to the same uid used to read the source, and seal it
  // during cloning so other sessions cannot traverse the copied workspace.
  await fs.mkdir(newWorkspaceDir, { recursive: true });
  const cloneUid = resolveGitTreeUid(activeSessionDir);
  if (cloneUid !== null) {
    await fs.chown(newSessionDir, cloneUid.uid, cloneUid.gid);
    await fs.chmod(newSessionDir, 0o700);
    await fs.chown(newWorkspaceDir, cloneUid.uid, cloneUid.gid);
  }
  // The dropped uid cannot hardlink root-owned cache objects; git does not fall
  // back to copying when protected_hardlinks rejects the link.
  await safeSimpleGit(activeSessionDir).raw([
    "clone",
    "--local",
    "--no-hardlinks",
    activeSessionDir,
    newWorkspaceDir,
  ]);

  // Transfer to the fork's identity after cloning but before its git operations.
  // Full chown is safe here because --no-hardlinks made every object private.
  allocateAndSealSessionDir(newSessionDir);
  chownTreeToSessionWorker(newWorkspaceDir);

  const newGit = safeSimpleGit(newWorkspaceDir);
  await newGit.raw(["config", "gc.auto", "0"]);
  if (activeSession?.remoteUrl) {
    await newGit.raw(["remote", "set-url", "origin", stripRemoteUrlCredentials(activeSession.remoteUrl)]);
  }
  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(newWorkspaceDir);
  }
  // Local clone's origin/* reflects the source's local branches, not upstream.
  const warn = report.warn ?? ((message: string) => console.warn(`[fork] ${message}`));
  if (activeSession?.remoteUrl) {
    try {
      const credential = await resolveTreeRemoteCredential(newWorkspaceDir, "origin", resolveRemoteCredential);
      await withPreemptiveAuthFallback(credential, "fork ref refresh", (cred) => (
        cred ? credentialledGit(newWorkspaceDir, cred) : newGit
      ).raw(["fetch", "origin", "--prune"]));
    } catch (err) {
      warn(
        "Could not refresh remote-tracking refs from origin, so this fork's first diff against "
        + `\`origin/<base>\` may look larger than it is — run \`git fetch origin --prune\`. (${String(err)})`,
      );
    }
  }
  // Correct origin/HEAD even without a remote or after a failed fetch.
  let bareCacheDir: string | null = null;
  try {
    bareCacheDir = activeSession?.remoteUrl ? getBareCacheDir(activeSession.remoteUrl) : null;
  } catch {
    // An unmappable URL leaves the parent as the fallback source.
  }
  await inheritOriginHead(activeSessionDir, newWorkspaceDir, bareCacheDir);

  const branchArgs = ["checkout", "-b", trimmed];
  if (startPoint) branchArgs.push(startPoint);
  await newGit.raw(branchArgs);

  // Local clone omits .git/lfs and orchestrator checkout disables smudge.
  // Materialize only after the final checkout, using the fork's identity.
  const lfs = await materializeLfsWithWarning(
    newWorkspaceDir,
    activeSession?.remoteUrl ?? newWorkspaceDir,
    warn,
  );

  const resolvedTitle = title?.trim() || `${activeSession?.title ?? "Session"} (${trimmed})`;
  sessionManager.track(newSessionId, resolvedTitle, newWorkspaceDir);
  sessionManager.setBranch(newSessionId, trimmed);
  if (activeSession?.remoteUrl) {
    sessionManager.setRemoteUrl(newSessionId, activeSession.remoteUrl);
  }

  // The notice needs the session row created by track().
  if (lfs.usesLfs && lfs.status !== "materialized") {
    report.noticeForAgent?.(newSessionId, buildLfsUnresolvedAgentNotice(lfs));
  }

  graduateSession(graduationDeps, {
    sessionId: newSessionId,
    userText: "",
    agentId: activeSession?.agentId ?? "claude",
    explicitTitle: resolvedTitle,
    explicitBranch: trimmed,
    skipBranchRename: true,
  });

  const newSession = sessionManager.get(newSessionId)!;
  console.log("[server] Forked session:", newSessionId, "branch:", trimmed);
  return {
    session: newSession,
    parentSessionId: activeSessionId,
    sessions: sessionManager.list(),
  };
}

export async function mergeSession(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
  activeSessionDir: string,
  sourceSessionId: string,
  resolveRemoteCredential?: GitRemoteCredentialResolver,
): Promise<{ success: boolean; message: string; conflicts?: string[] }> {
  const trimmedId = sourceSessionId.trim();
  if (!trimmedId) throw new ServiceError(400, "Source session ID is required");

  const sourceSession = sessionManager.get(trimmedId);
  if (!sourceSession) throw new ServiceError(404, "Source session not found");
  if (!sourceSession.branch) throw new ServiceError(400, "Source session has no branch");

  const git = createGitManager(activeSessionDir);
  const sg = safeSimpleGit(activeSessionDir);

  let mergeRef = `origin/${sourceSession.branch}`;
  let fetched = false;

  if (sourceSession.workspaceDir) {
    const sourceGit = createGitManager(sourceSession.workspaceDir);
    try {
      await sourceGit.push("origin", sourceSession.branch);
      const credential = await resolveTreeRemoteCredential(activeSessionDir, "origin", resolveRemoteCredential);
      const originGit = credential ? credentialledGit(activeSessionDir, credential) : sg;
      await originGit.fetch("origin", sourceSession.branch);
      fetched = true;
    } catch {
      // Fall back to fetching the local clone.
    }

    if (!fetched) {
      const remoteName = `merge-source-${trimmedId.slice(0, 8)}`;
      try {
        await sg.addRemote(remoteName, sourceSession.workspaceDir);
      } catch {
        // A previous attempt may have left the remote.
      }
      try {
        await sg.fetch(remoteName, sourceSession.branch);
        mergeRef = `${remoteName}/${sourceSession.branch}`;
        fetched = true;
      } catch {
        // Let merge report whether an existing ref is usable.
      }
    }
  }

  let result: Awaited<ReturnType<typeof git.merge>>;
  try {
    result = await git.merge(mergeRef);
  } finally {
    try {
      const remotes = await sg.getRemotes();
      for (const r of remotes) {
        if (r.name.startsWith("merge-source-")) {
          await sg.removeRemote(r.name);
        }
      }
    } catch { /* ignore cleanup errors */ }
    // Both merge and conflict abort can leave LFS pointers after checkout.
    await restoreLfsAfterTreeRewrite(activeSessionDir, "Merge", (message) =>
      console.warn(`[fork-merge] ${message}`),
    );
    handWorkspaceBackToWorker(activeSessionDir);
  }

  if (result.success) {
    return {
      success: true,
      message: `Merged branch '${sourceSession.branch}' successfully`,
    };
  }
  return {
    success: false,
    message: `Merge conflict on branch '${sourceSession.branch}'`,
    conflicts: result.conflicts,
  };
}
