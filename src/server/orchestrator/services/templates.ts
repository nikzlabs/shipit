/**
 * Template mutation services — apply project templates, create repos with templates.
 */

import fs from "node:fs/promises";
import os from "node:os";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo } from "../../shared/types.js";
import { getTemplate, applyTemplate as applyTemplateFiles, generatePackageLock, OPS_TEMPLATE_ID } from "../templates.js";
import { ServiceError } from "./types.js";

/** Create a GitHub repo with a template applied, committed, and pushed.
 *  Does NOT create a session — the caller should warm one via warmSessionForRepo(). */
export async function createRepoWithTemplate(
  createGitManager: (dir: string) => GitManager,
  githubAuthManager: {
    authenticated: boolean;
    createRepo: (name: string, opts: { description?: string; isPrivate?: boolean }) => Promise<{ success: boolean; cloneUrl?: string; message?: string }>;
    configureGitCredentials: (dir: string) => void;
  },
  getSharedRepoDir: (repoUrl: string) => string,
  repoName: string,
  templateId: string,
  description?: string,
  isPrivate?: boolean,
): Promise<{ success: boolean; repoUrl?: string; message?: string }> {
  const trimmedName = repoName.trim();
  if (!trimmedName) throw new ServiceError(400, "Repository name is required");
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmedName)) throw new ServiceError(400, "Repository name contains invalid characters");

  const trimmedTemplateId = templateId.trim();
  if (!trimmedTemplateId) throw new ServiceError(400, "Template is required");

  const template = getTemplate(trimmedTemplateId);
  if (!template) throw new ServiceError(400, `Unknown template: ${trimmedTemplateId}`);

  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  // 1. Create GitHub repo
  const repoResult = await githubAuthManager.createRepo(trimmedName, { description, isPrivate });
  if (!repoResult.success || !repoResult.cloneUrl) {
    return { success: false, message: repoResult.message || "Failed to create repository" };
  }

  // 2. Set up the bare repo cache dir — acts as the reference clone for all sessions
  const repoDir = getSharedRepoDir(repoResult.cloneUrl);
  await fs.mkdir(repoDir, { recursive: true });
  const sharedGit = createGitManager(repoDir);
  await sharedGit.init();
  await sharedGit.addRemote("origin", repoResult.cloneUrl);
  githubAuthManager.configureGitCredentials(repoDir);

  // 3. Apply template, generate lock file, and push to main (establishes repo base)
  await applyTemplateFiles(template, repoDir);
  if (template.files["package.json"]) {
    try { await generatePackageLock(repoDir); } catch { /* non-fatal */ }
  }
  await sharedGit.autoCommit(`Initial setup: ${template.name}`);
  await sharedGit.push("origin", "main");

  return {
    success: true,
    repoUrl: repoResult.cloneUrl,
  };
}

/** Apply a template to a session directory. Creates session if needed. */
export async function applyTemplate(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>,
  templateId: string,
  sessionId?: string,
): Promise<{ templateId: string; name: string; session?: SessionInfo; sessionDir: string }> {
  if (!templateId || typeof templateId !== "string" || !templateId.trim()) {
    throw new ServiceError(400, "Template ID is required");
  }
  const trimmedTemplateId = templateId.trim();
  const template = getTemplate(trimmedTemplateId);
  if (!template) throw new ServiceError(400, `Unknown template: ${templateId}`);

  const isOps = trimmedTemplateId === OPS_TEMPLATE_ID;
  // docs/128 — the privileged ops template only ever bootstraps a *fresh*
  // session. Refusing an existing sessionId prevents an ordinary session from
  // being retrofitted into a privileged one via this route.
  if (isOps && sessionId) {
    throw new ServiceError(400, "Ops session must be created fresh (use sessionId 'new')");
  }

  let appSessionId = sessionId;
  let sessionDir: string;

  if (appSessionId) {
    const session = sessionManager.get(appSessionId);
    if (!session?.workspaceDir) throw new ServiceError(404, "Session not found");
    sessionDir = session.workspaceDir;
  } else {
    const created = await createSessionDir(isOps ? `Ops — ${os.hostname()}` : template.name);
    appSessionId = created.appSessionId;
    sessionDir = created.workspaceDir;
    // New session directory needs git init before we can commit template files
    const newGit = createGitManager(sessionDir);
    await newGit.init();
  }

  // docs/128 — set the server-authoritative kind BEFORE the agent container can
  // ever boot. This single field (never a workspace file) gates the privileged
  // journal mounts + read-only Docker proxy in container-lifecycle.ts.
  if (isOps) sessionManager.setKind(appSessionId, "ops");

  await applyTemplateFiles(template, sessionDir);
  if (template.files["package.json"]) {
    try { await generatePackageLock(sessionDir); } catch { /* non-fatal */ }
  }
  const git = createGitManager(sessionDir);
  await git.autoCommit(`Apply template: ${template.name}`);

  const session = sessionManager.get(appSessionId);
  return {
    templateId: template.id,
    name: template.name,
    session: session ?? undefined,
    sessionDir,
  };
}
