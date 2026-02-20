import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";
import { listTemplates, getTemplate, applyTemplate } from "../templates.js";

type WsApplyTemplate = Extract<WsClientMessage, { type: "apply_template" }>;
type WsHomeCreateRepoWithTemplate = Extract<WsClientMessage, { type: "home_create_repo_with_template" }>;

export function handleListTemplates(ctx: HandlerContext): void {
  ctx.send({ type: "template_list", templates: listTemplates() });
}

export async function handleApplyTemplate(ctx: HandlerContext, msg: WsApplyTemplate): Promise<void> {
  const templateId = msg.templateId;
  if (!templateId || typeof templateId !== "string" || !templateId.trim()) {
    ctx.send({ type: "error", message: "Template ID is required" });
    return;
  }
  const template = getTemplate(templateId.trim());
  if (!template) {
    ctx.send({ type: "error", message: `Unknown template: ${templateId}` });
    return;
  }
  try {
    // If no active session, create one for the template
    let activeAppSessionId = ctx.getActiveAppSessionId();
    if (!activeAppSessionId) {
      const { appSessionId, sessionDir } = await ctx.createSessionDir(template.name);
      activeAppSessionId = appSessionId;
      ctx.setActiveAppSessionId(appSessionId);
      ctx.setActiveSessionDir(sessionDir);

      // Restart file watcher to the new session directory
      ctx.fileWatcher.stop();
      ctx.fileWatcher.start(sessionDir);

      const session = ctx.sessionManager.get(appSessionId);
      if (session) {
        ctx.send({ type: "session_started", session });
      }
    }

    const dir = ctx.getActiveDir();
    await applyTemplate(template, dir);
    const git = ctx.getActiveGitManager();
    await git.autoCommit(`Apply template: ${template.name}`);
    // Restart Vite so it picks up the new project files
    // Note: the install command from shipit.yaml is handled by PreviewManager
    // when it starts the preview (see preview-manager.ts / install-runner.ts).
    ctx.viteManager.restart(dir);
    ctx.send({ type: "template_applied", templateId: template.id, name: template.name });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to apply template: ${getErrorMessage(err)}` });
  }
}

export async function handleHomeCreateRepoWithTemplate(ctx: HandlerContext, msg: WsHomeCreateRepoWithTemplate): Promise<void> {
  const repoName = typeof msg.repoName === "string" ? msg.repoName.trim() : "";
  if (!repoName) {
    ctx.send({ type: "home_repo_ready", success: false, message: "Repository name is required" });
    return;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
    ctx.send({ type: "home_repo_ready", success: false, message: "Repository name contains invalid characters" });
    return;
  }
  const templateId = typeof msg.templateId === "string" ? msg.templateId.trim() : "";
  if (!templateId) {
    ctx.send({ type: "home_repo_ready", success: false, message: "Template is required" });
    return;
  }
  const template = getTemplate(templateId);
  if (!template) {
    ctx.send({ type: "home_repo_ready", success: false, message: `Unknown template: ${templateId}` });
    return;
  }
  if (!ctx.githubAuthManager.authenticated) {
    ctx.send({ type: "home_repo_ready", success: false, message: "Not authenticated with GitHub" });
    return;
  }

  try {
    // 1. Create GitHub repo
    const repoResult = await ctx.githubAuthManager.createRepo(repoName, {
      description: msg.description,
      isPrivate: msg.isPrivate,
    });
    if (!repoResult.success || !repoResult.cloneUrl) {
      ctx.send({ type: "home_repo_ready", success: false, message: repoResult.message || "Failed to create repository" });
      return;
    }

    // 2. Create session
    const { appSessionId, sessionDir } = await ctx.createSessionDir(template.name);
    ctx.setActiveAppSessionId(appSessionId);
    ctx.setActiveSessionDir(sessionDir);
    ctx.fileWatcher.stop();
    ctx.fileWatcher.start(sessionDir);

    // 3. Add remote and configure credentials
    const git = ctx.createGitManager(sessionDir);
    await git.addRemote("origin", repoResult.cloneUrl);

    // 4. Apply template
    await applyTemplate(template, sessionDir);
    await git.autoCommit(`Initial setup: ${template.name}`);

    // 5. Push to main
    await git.push("origin", "main");

    // 6. Update session metadata
    ctx.sessionManager.setRemoteUrl(appSessionId, repoResult.cloneUrl);
    const session = ctx.sessionManager.get(appSessionId);

    // 7. Notify client
    if (session) {
      ctx.send({ type: "session_started", session });
    }

    // Restart Vite — install from shipit.yaml is handled by PreviewManager
    ctx.viteManager.restart(sessionDir);

    ctx.send({
      type: "home_repo_ready",
      success: true,
      repoUrl: repoResult.cloneUrl,
      sessionId: appSessionId,
    });
  } catch (err) {
    ctx.send({ type: "home_repo_ready", success: false, message: getErrorMessage(err) });
  }
}
