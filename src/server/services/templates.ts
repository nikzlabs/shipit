/**
 * Template mutation services — apply project templates.
 */

import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../git.js";
import type { SessionInfo } from "../types.js";
import { getTemplate, applyTemplate as applyTemplateFiles } from "../templates.js";
import { ServiceError } from "./types.js";

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
