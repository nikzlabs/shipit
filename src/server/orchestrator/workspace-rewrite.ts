/**
 * nikzlabs/shipit#2429 — what a live session owes after the ORCHESTRATOR rewrote its
 * working tree: re-read the config, and re-check the dependencies.
 *
 * ShipIt rewrites a session's checkout from outside the container in four
 * places — the sync/rebase driver, the rollback route, the explicit
 * `shipit branch reset-to-base`, and the pre-turn auto-reset of a merged branch.
 * Every one of them can bring in a different `shipit.yaml`, a different compose
 * file, and a different lockfile, all at once, while the container keeps running
 * on what it read before.
 *
 * The in-container inotify watcher is the signal for an *agent* edit and is not
 * a signal for these: it is started best-effort with a single fire-and-forget
 * POST, and it watches a bind mount written to from another container, so a
 * cross-mount event can be missed entirely — or the watcher was never started.
 * The orchestrator knows exactly when it rewrote the tree, so it says so
 * directly.
 *
 * The two halves shipped separately and drifted, which is why they live here
 * together now. The config half (`reevaluateWorkspaceConfig`) was wired to the
 * rebase and rollback paths and to neither reset path; the dependency half did
 * not exist at all, so a sync that added an npm dependency left `node_modules`
 * on the pre-sync tree and the preview failing every request on an unresolvable
 * import, with nothing anywhere saying the two were out of step. A caller that
 * rewrites the tree calls this one function and gets both.
 *
 * Order is deliberate: the config re-read is what applies a NEW `shipit.yaml`'s
 * `agent.install` / `install-inputs` to the runner (`applyShipitConfigChange`
 * does that synchronously), so the dependency check that follows it evaluates
 * the incoming config rather than the outgoing one.
 *
 * Best-effort by construction. Both halves already ran their real work — the
 * rebase landed, the reset moved the branch — so neither a config re-read nor a
 * dependency check may turn a completed rewrite into a reported failure.
 */

import type { SessionRunnerInterface } from "./session-runner.js";
import { getErrorMessage } from "./validation.js";

/** The runner surface this module touches. Both members are optional on the
 * interface (container runners only), so a narrower stub satisfies it. */
export type WorkspaceRewriteRunner = Pick<
  SessionRunnerInterface,
  "reevaluateWorkspaceConfig" | "notifyWorkspaceRewritten"
>;

/**
 * Tell a live session that its working tree was rewritten from outside the
 * container.
 *
 * @param runner  the session's runner, or null/undefined when it has none — an
 *                idle session with no container has nothing to re-read, and its
 *                next start reads everything fresh anyway.
 * @param label   log prefix identifying the caller (`rebase`, `rollback`, …).
 */
export function onWorkspaceRewritten(
  runner: WorkspaceRewriteRunner | null | undefined,
  label: string,
): void {
  if (!runner) return;
  try {
    runner.reevaluateWorkspaceConfig?.();
  } catch (err) {
    console.error(`[${label}] config re-evaluation failed:`, getErrorMessage(err));
  }
  try {
    runner.notifyWorkspaceRewritten?.();
  } catch (err) {
    console.error(`[${label}] dependency re-check failed:`, getErrorMessage(err));
  }
}
