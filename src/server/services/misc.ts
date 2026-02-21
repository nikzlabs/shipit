/**
 * Miscellaneous mutation services — full reset, preview errors.
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { ServiceError } from "./types.js";

/** Full reset — destroys all workspace data. */
export async function fullReset(
  sessionManager: SessionManager,
  usageManager: UsageManager,
  runnerRegistry: SessionRunnerRegistry,
  workspaceDir: string,
): Promise<void> {
  // Dispose all runners
  runnerRegistry.disposeAll();

  // Delete everything inside the workspace directory
  const entries = await fs.readdir(workspaceDir);
  for (const entry of entries) {
    try {
      await fs.rm(path.join(workspaceDir, entry), { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }

  // Clear in-memory state
  sessionManager.clear();
  usageManager.clear();
}

/** Report a preview error (log broadcast). */
export function validatePreviewError(
  message: string,
  stack?: string,
): { message: string; stack?: string } {
  const errorMsg = typeof message === "string" ? message : "";
  if (!errorMsg.trim()) throw new ServiceError(400, "Preview error message cannot be empty");
  if (errorMsg.length > 10_000) throw new ServiceError(400, "Preview error message too long (max 10,000 characters)");
  const trimmedStack = stack && typeof stack === "string" ? stack.slice(0, 5000) : undefined;
  return { message: errorMsg, stack: trimmedStack };
}
