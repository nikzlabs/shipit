/**
 * The GLOBAL system prompt — the free-text block a user types into
 * Settings → "System prompt", prepended to every session's first turn.
 *
 * It is stored at `<appWorkspaceDir>/.shipit/system-prompt.md`, and the whole
 * point of this module is the first word of that path. **`appWorkspaceDir` is
 * the orchestrator's own workspace root** — `/workspace` in production, the
 * directory that holds `sessions/` and therefore sits one level above every
 * session's clone. It is NOT a session clone, and nothing here ever touches a
 * user's repository.
 *
 * That distinction had been left to the reader, because the codebase calls both
 * things `workspaceDir`: `AppDeps.workspaceDir` is this root, while
 * `SessionInfo.workspaceDir` / `ServiceManagerOptions.workspaceDir` are a
 * session's git clone. The ambiguity is not cosmetic — confusing the two is what
 * produced the docs/246 bug where a flat-layout session resolved its state dir
 * to a host-shared `<sessionsRoot>/state`. So the four call sites that used to
 * compose this path by hand now go through one helper whose parameter says which
 * root it wants, and `.shipit` appears in exactly one place instead of four.
 *
 * Session-scoped ShipIt state has its own module and its own rule: it lives
 * outside the clone (`session-state-dir.ts`, docs/246 req 7). Nothing
 * ShipIt-generated may be written into a clone's `.shipit/` at all —
 * `no-clone-writes.test.ts` enforces that with no exemptions.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Directory under the app workspace root that holds global ShipIt settings. */
const APP_SETTINGS_SUBDIR = ".shipit";

/** Filename of the global system prompt. */
const GLOBAL_SYSTEM_PROMPT_FILE = "system-prompt.md";

/**
 * Path of the global system prompt file.
 *
 * @param appWorkspaceDir The ORCHESTRATOR's workspace root (`AppDeps.workspaceDir`),
 *   never a session clone.
 */
export function globalSystemPromptPath(appWorkspaceDir: string): string {
  return path.join(appWorkspaceDir, APP_SETTINGS_SUBDIR, GLOBAL_SYSTEM_PROMPT_FILE);
}

/**
 * Read the global system prompt, trimmed. Returns `undefined` when the file is
 * missing, unreadable, or blank — every caller treats "no prompt configured"
 * and "couldn't read it" the same way, so the distinction is not surfaced.
 *
 * @param appWorkspaceDir The ORCHESTRATOR's workspace root, never a session clone.
 */
export async function readGlobalSystemPrompt(appWorkspaceDir: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(globalSystemPromptPath(appWorkspaceDir), "utf-8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the global system prompt, or delete the file when `content` is blank —
 * clearing the box in Settings means "no global prompt", not "a prompt that is
 * the empty string".
 *
 * @param appWorkspaceDir The ORCHESTRATOR's workspace root, never a session clone.
 */
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
