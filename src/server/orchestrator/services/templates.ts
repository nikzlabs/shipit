import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { SessionCapabilities, SessionInfo } from "../../shared/types.js";
import { normalizeCapabilities } from "../../shared/types.js";
import { getTemplate, applyTemplate as applyTemplateFiles, generatePackageLock, OPS_TEMPLATE_ID, buildOpsInvestigationSeed } from "../templates.js";
import { ServiceError } from "./types.js";
import { validateNonEmptyString } from "./validation.js";

export async function createRepoWithTemplate(
  createGitManager: (dir: string) => GitManager,
  createRepoGit: (dir: string) => RepoGit,
  githubAuthManager: {
    authenticated: boolean;
    createRepo: (name: string, opts: { description?: string; isPrivate?: boolean; owner?: string }) => Promise<{ success: boolean; cloneUrl?: string; message?: string }>;
  },
  getSharedRepoDir: (repoUrl: string) => string,
  repoName: string,
  templateId: string,
  description?: string,
  isPrivate?: boolean,
  owner?: string,
): Promise<{ success: boolean; repoUrl?: string; message?: string }> {
  const trimmedName = repoName.trim();
  if (!trimmedName) throw new ServiceError(400, "Repository name is required");
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmedName)) throw new ServiceError(400, "Repository name contains invalid characters");

  const trimmedTemplateId = templateId.trim();
  if (!trimmedTemplateId) throw new ServiceError(400, "Template is required");

  const template = getTemplate(trimmedTemplateId);
  if (!template) throw new ServiceError(400, `Unknown template: ${trimmedTemplateId}`);

  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const trimmedOwner = owner?.trim();
  const repoResult = await githubAuthManager.createRepo(trimmedName, {
    description,
    isPrivate,
    ...(trimmedOwner ? { owner: trimmedOwner } : {}),
  });
  if (!repoResult.success || !repoResult.cloneUrl) {
    return { success: false, message: repoResult.message || "Failed to create repository" };
  }
  const cloneUrl = repoResult.cloneUrl;

  // The shared cache is bare, so scaffold in a temporary working tree.
  const scaffoldDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipit-template-"));
  try {
    const scaffoldGit = createGitManager(scaffoldDir);
    await scaffoldGit.init();
    await scaffoldGit.addRemote("origin", cloneUrl);
    await applyTemplateFiles(template, scaffoldDir);
    if (template.files["package.json"]) {
      try { await generatePackageLock(scaffoldDir); } catch { /* non-fatal */ }
    }
    await scaffoldGit.autoCommit(`Initial setup: ${template.name}`);
    await scaffoldGit.push("origin", "main");

    const repoDir = getSharedRepoDir(cloneUrl);
    await fs.mkdir(repoDir, { recursive: true });
    const cacheGit = createRepoGit(repoDir);
    await cacheGit.cloneBare(scaffoldDir);
    await cacheGit.setRemoteUrl(cloneUrl);
  } finally {
    await fs.rm(scaffoldDir, { recursive: true, force: true });
  }

  return {
    success: true,
    repoUrl: cloneUrl,
  };
}

export async function applyTemplate(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>,
  templateId: string,
  sessionId?: string,
  targetSessionId?: string,
): Promise<{ templateId: string; name: string; session?: SessionInfo; sessionDir: string; seedPrompt?: string }> {
  validateNonEmptyString(templateId, "Template ID");
  const trimmedTemplateId = templateId.trim();
  const template = getTemplate(trimmedTemplateId);
  if (!template) throw new ServiceError(400, `Unknown template: ${templateId}`);

  const isOps = trimmedTemplateId === OPS_TEMPLATE_ID;
  if (isOps && sessionId) {
    throw new ServiceError(400, "Ops session must be created fresh (use sessionId 'new')");
  }

  let seedPrompt: string | undefined;
  let opsTitle = `Ops — ${os.hostname()}`;
  if (isOps && targetSessionId) {
    const target = sessionManager.get(targetSessionId);
    if (target) {
      opsTitle = `Ops — debug: ${target.title}`;
      seedPrompt = buildOpsInvestigationSeed({
        id: target.id,
        title: target.title,
        ...(target.remoteUrl ? { remoteUrl: target.remoteUrl } : {}),
        ...(target.branch ? { branch: target.branch } : {}),
      });
    }
  }

  let appSessionId = sessionId;
  let sessionDir: string;

  if (appSessionId) {
    const session = sessionManager.get(appSessionId);
    if (!session?.workspaceDir) throw new ServiceError(404, "Session not found");
    sessionDir = session.workspaceDir;
  } else {
    const created = await createSessionDir(isOps ? opsTitle : template.name);
    appSessionId = created.appSessionId;
    sessionDir = created.workspaceDir;
    const newGit = createGitManager(sessionDir);
    await newGit.init();
  }

  if (isOps) sessionManager.setKind(appSessionId, "ops");

  await applyTemplateFiles(template, sessionDir);
  if (template.files["package.json"]) {
    try { await generatePackageLock(sessionDir); } catch { /* non-fatal */ }
  }
  const git = createGitManager(sessionDir);
  // Ops sessions still need a committed template baseline despite their automatic-commit gate.
  await git.autoCommit(`Apply template: ${template.name}`);

  const session = sessionManager.get(appSessionId);
  return {
    templateId: template.id,
    name: template.name,
    session: session ?? undefined,
    sessionDir,
    ...(seedPrompt ? { seedPrompt } : {}),
  };
}

export async function createSandboxSession(
  sessionManager: SessionManager,
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>,
  capabilities?: Partial<SessionCapabilities>,
): Promise<{ session: SessionInfo; sessionDir: string; capabilities: SessionCapabilities }> {
  const normalized = normalizeCapabilities(capabilities);
  const created = await createSessionDir("Sandbox session");
  sessionManager.setKind(created.appSessionId, "sandbox");
  sessionManager.setCapabilities(created.appSessionId, normalized);
  const session = sessionManager.get(created.appSessionId);
  if (!session) throw new ServiceError(500, "Sandbox session vanished after creation");
  return { session, sessionDir: created.workspaceDir, capabilities: normalized };
}
