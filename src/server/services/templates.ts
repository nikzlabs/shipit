/**
 * Template mutation services — apply project templates, create repos with templates.
 */

import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../git.js";
import type { SessionInfo } from "../types.js";
import { getTemplate, applyTemplate as applyTemplateFiles } from "../templates.js";
import { ServiceError } from "./types.js";

/** Create a GitHub repo with a template applied, committed, and pushed. */
export async function createRepoWithTemplate(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string }>,
  githubAuthManager: {
    authenticated: boolean;
    createRepo: (name: string, opts: { description?: string; isPrivate?: boolean }) => Promise<{ success: boolean; cloneUrl?: string; message?: string }>;
  },
  repoName: string,
  templateId: string,
  description?: string,
  isPrivate?: boolean,
): Promise<{ success: boolean; repoUrl?: string; sessionId?: string; message?: string }> {
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

  // 2. Create session
  const { appSessionId, sessionDir } = await createSessionDir(template.name);

  // 3. Add remote and configure credentials
  const git = createGitManager(sessionDir);
  await git.addRemote("origin", repoResult.cloneUrl);

  // 4. Apply template
  await applyTemplateFiles(template, sessionDir);
  await git.autoCommit(`Initial setup: ${template.name}`);

  // 5. Push to main
  await git.push("origin", "main");

  // 6. Update session metadata
  sessionManager.setRemoteUrl(appSessionId, repoResult.cloneUrl);

  return {
    success: true,
    repoUrl: repoResult.cloneUrl,
    sessionId: appSessionId,
  };
}

/** Apply a template to a session directory. Creates session if needed. */
export async function applyTemplate(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string }>,
  templateId: string,
  sessionId?: string,
): Promise<{ templateId: string; name: string; session?: SessionInfo; sessionDir: string }> {
  if (!templateId || typeof templateId !== "string" || !templateId.trim()) {
    throw new ServiceError(400, "Template ID is required");
  }
  const template = getTemplate(templateId.trim());
  if (!template) throw new ServiceError(400, `Unknown template: ${templateId}`);

  let appSessionId = sessionId;
  let sessionDir: string;

  if (appSessionId) {
    const session = sessionManager.get(appSessionId);
    if (!session?.workspaceDir) throw new ServiceError(404, "Session not found");
    sessionDir = session.workspaceDir;
  } else {
    const created = await createSessionDir(template.name);
    appSessionId = created.appSessionId;
    sessionDir = created.sessionDir;
  }

  await applyTemplateFiles(template, sessionDir);
  const git = createGitManager(sessionDir);
  await git.autoCommit(`Apply template: ${template.name}`);

  const session = sessionManager.get(appSessionId!);
  return {
    templateId: template.id,
    name: template.name,
    session: session ?? undefined,
    sessionDir,
  };
}
