import type { SessionRunnerInterface } from "./session-runner.js";
import { getErrorMessage } from "./validation.js";

export type WorkspaceRewriteRunner = Pick<
  SessionRunnerInterface,
  "reevaluateWorkspaceConfig" | "notifyWorkspaceRewritten"
>;

// External tree rewrites may not reach the container's file watcher.
export function onWorkspaceRewritten(
  runner: WorkspaceRewriteRunner | null | undefined,
  label: string,
): void {
  if (!runner) return;
  try {
    // Apply new install settings before checking dependencies.
    runner.reevaluateWorkspaceConfig?.();
  } catch (err) {
    console.error(`[${label}] config re-evaluation failed:`, getErrorMessage(err));
  }
  try {
    runner.notifyWorkspaceRewritten?.(label);
  } catch (err) {
    console.error(`[${label}] dependency re-check failed:`, getErrorMessage(err));
  }
}
