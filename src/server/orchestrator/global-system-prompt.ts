import fs from "node:fs/promises";
import path from "node:path";

const APP_SETTINGS_SUBDIR = ".shipit";

/**
 * An ops session never receives the standard block: ShipIt's own ops instructions
 * contradict ordinary project conventions (docs/014-system-prompt req 6).
 */
export type SystemPromptScope = "standard" | "ops";

const PROMPT_FILES: Record<SystemPromptScope, string> = {
  standard: "system-prompt.md",
  ops: "system-prompt-ops.md",
};

// appWorkspaceDir is the orchestrator root, never a session clone.
export function globalSystemPromptPath(
  appWorkspaceDir: string,
  scope: SystemPromptScope = "standard",
): string {
  return path.join(appWorkspaceDir, APP_SETTINGS_SUBDIR, PROMPT_FILES[scope]);
}

export async function readGlobalSystemPrompt(
  appWorkspaceDir: string,
  scope: SystemPromptScope = "standard",
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(globalSystemPromptPath(appWorkspaceDir, scope), "utf-8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function writeGlobalSystemPrompt(
  appWorkspaceDir: string,
  content: string,
  scope: SystemPromptScope = "standard",
): Promise<void> {
  const filePath = globalSystemPromptPath(appWorkspaceDir, scope);
  const trimmed = content.trim();
  if (!trimmed) {
    try { await fs.unlink(filePath); } catch { /* ok if missing */ }
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${trimmed}\n`, "utf-8");
}
