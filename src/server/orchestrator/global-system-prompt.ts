import fs from "node:fs/promises";
import path from "node:path";

const APP_SETTINGS_SUBDIR = ".shipit";
const GLOBAL_SYSTEM_PROMPT_FILE = "system-prompt.md";

// appWorkspaceDir is the orchestrator root, never a session clone.
export function globalSystemPromptPath(appWorkspaceDir: string): string {
  return path.join(appWorkspaceDir, APP_SETTINGS_SUBDIR, GLOBAL_SYSTEM_PROMPT_FILE);
}

export async function readGlobalSystemPrompt(appWorkspaceDir: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(globalSystemPromptPath(appWorkspaceDir), "utf-8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function writeGlobalSystemPrompt(appWorkspaceDir: string, content: string): Promise<void> {
  const filePath = globalSystemPromptPath(appWorkspaceDir);
  const trimmed = content.trim();
  if (!trimmed) {
    try { await fs.unlink(filePath); } catch { /* ok if missing */ }
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${trimmed}\n`, "utf-8");
}
