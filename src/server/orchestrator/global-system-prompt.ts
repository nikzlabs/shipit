import fs from "node:fs/promises";
import path from "node:path";
import { APPLIED, applyFailed } from "../shared/settings-catalogue/index.js";
import type { ApplyOutcome } from "../shared/settings-catalogue/index.js";

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

/**
 * Reports whether the instructions are what the caller asked for, and never
 * throws for a write it could not do (docs/299 → "Saved" has to mean saved).
 *
 * Clearing used to swallow the `unlink` error, so "cleared" could be false while
 * the old instructions were still being sent to every agent. A write used to
 * throw, which was worse than swallowing in a different way: it abandoned a
 * multi-setting save part-way, losing both the outcomes already collected and
 * the broadcast for the settings that had landed.
 *
 * The content is staged and renamed over the target, so a failure part-way
 * cannot leave a truncated file — which is what lets a failure claim `failed`
 * rather than `uncertain`: the previous instructions are verifiably still there.
 */
export async function writeGlobalSystemPrompt(
  appWorkspaceDir: string,
  content: string,
  scope: SystemPromptScope = "standard",
): Promise<ApplyOutcome> {
  const filePath = globalSystemPromptPath(appWorkspaceDir, scope);
  const trimmed = content.trim();
  if (!trimmed) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      // A missing file is already cleared, so answering `failed` for that would
      // make every repeat clear look like a failure.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return APPLIED;
      console.error(`[global-system-prompt] clearing ${filePath} failed:`, err);
      return applyFailed(
        "ShipIt could not delete the instructions file, so the previous instructions are still in place.",
      );
    }
    return APPLIED;
  }
  const staging = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(staging, `${trimmed}\n`, "utf-8");
    await fs.rename(staging, filePath);
    return APPLIED;
  } catch (err) {
    console.error(`[global-system-prompt] writing ${filePath} failed:`, err);
    await fs.rm(staging, { force: true }).catch(() => undefined);
    return applyFailed(
      "ShipIt could not write the instructions file, so the previous instructions are still in place.",
    );
  }
}
