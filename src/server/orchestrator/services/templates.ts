/**
 * Template mutation services — apply project templates, create repos with templates.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { SessionInfo } from "../../shared/types.js";
import { getTemplate, applyTemplate as applyTemplateFiles, generatePackageLock, OPS_TEMPLATE_ID, buildOpsInvestigationSeed } from "../templates.js";
import { ServiceError } from "./types.js";

/** Create a GitHub repo with a template applied, committed, and pushed.
 *  Does NOT create a session — the caller should warm one via warmSessionForRepo(). */
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

  // 1. Create GitHub repo. A truthy `owner` targets that organization
  //    (POST /orgs/{owner}/repos); omitted/empty falls back to the personal
  //    account, so a personal repo never accidentally hits the org endpoint.
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

  // 2. Scaffold the template in a throwaway working tree, commit, and push to
  //    establish the repo's base on GitHub. We deliberately do NOT scaffold
  //    into the shared cache dir: that dir must be a *bare* repo (step 3), and
  //    a bare repo has no working tree to write files into. The push
  //    authenticates via the orchestrator's global git credential helper
  //    (installed whenever a token exists), so no per-dir credential setup is
  //    needed here.
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

    // 3. Create the shared cache as a *bare* repo. Bare-clone from the local
    //    scaffold — which already holds the pushed history — instead of
    //    re-downloading from the remote we just pushed to, then repoint origin
    //    at the real remote for future fetches. The result matches the
    //    add-by-URL path (a bare cache with `main` and origin = the GitHub URL)
    //    without a redundant network round-trip. The previous implementation
    //    `git init`'d this dir as a *non-bare* working tree with `main` checked
    //    out, which made every later cache fetch fail with "refusing to fetch
    //    into branch 'refs/heads/main' checked out" (docs/192).
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

/** Apply a template to a session directory. Creates session if needed. */
export async function applyTemplate(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
  createSessionDir: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>,
  templateId: string,
  sessionId?: string,
  targetSessionId?: string,
): Promise<{ templateId: string; name: string; session?: SessionInfo; sessionDir: string; seedPrompt?: string }> {
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

  // docs/128 — "Investigate in Ops session" entry point. `targetSessionId` is
  // a *reference* to the session the operator wants to debug — never the
  // session being templated — so it doesn't weaken the fresh-only privilege
  // gate above. We use it to name the new ops session after its quarry and to
  // seed the composer with a concrete read-only first step (the agent filters
  // containers by the target id). Silently ignored for non-ops templates or an
  // unknown id, so a stale reference still yields a usable generic ops session.
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
    ...(seedPrompt ? { seedPrompt } : {}),
  };
}
