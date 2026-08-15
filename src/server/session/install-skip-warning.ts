/**
 * Skip-time warning for install output no `dep-dirs` entry covers (planning#2315).
 *
 * A container is replaced, not paused, so the next one on the same commit starts
 * from a fresh clone. Gitignored paths are not in that clone, and the only
 * directories brought back are the declared `agent.dep-dirs` (via the overlay
 * store). When the install marker still matches, `agent.install` does not run —
 * so a build step's output, if it lives outside `dep-dirs` and git ignores it,
 * is simply gone while every activation surface reports the install done.
 *
 * That combination is invisible today: it is deterministic from the *second*
 * container for a commit onward, which reads as intermittent ("it worked earlier
 * today") and produces no error anywhere. This is the log line that names it.
 *
 * **The signal is a guess, and stays cheap on purpose.** We cannot know what an
 * install writes without running it, so the check is the same allowlist the
 * content-keyed skip already uses (`depInputsForCommand`): a command that is not
 * a recognized *pure dependency install* probably writes something else. Paired
 * with `dep-dirs` left at its default, that is very likely wrong — but a false
 * positive (a build whose output is committed, or which the session never needs)
 * must cost one line in the install log, never a session. So this warns and
 * changes nothing: it never blocks, never re-runs the install, and never fails.
 *
 * It fires at **skip time** rather than when the config is read. At config-read
 * time on the first container the install is about to run and the output will be
 * present, so the warning would be noise on a session that is working; the skip
 * is the exact moment the output is missing, and it sits beside the one other
 * check that distrusts a matching marker (`overlay-dep-check.ts`).
 */

import { depInputsForCommand } from "../shared/deps-hash.js";
import { DEFAULT_DEP_DIRS } from "../shared/shipit-config.js";

/** True when `depDirs` is exactly the default set — nothing beyond `node_modules`. */
function isDefaultDepDirs(depDirs: readonly string[]): boolean {
  return (
    depDirs.length === DEFAULT_DEP_DIRS.length &&
    depDirs.every((d, i) => d === DEFAULT_DEP_DIRS[i])
  );
}

/**
 * The `agent.install` steps that are not recognized pure dependency installs —
 * i.e. the ones that probably write somewhere other than a dependency directory.
 * Exactly the condition that already forces the marker's `depsHash` to `null`.
 */
export function nonDependencyInstallSteps(commands: readonly string[]): string[] {
  return commands.filter((c) => depInputsForCommand(c) === null);
}

/**
 * The warning to log when an install is skipped, or `null` when there is nothing
 * worth saying. Pure: the caller decides where it goes.
 *
 * Warns only when both halves hold — a step that is not a pure dependency
 * install, and `dep-dirs` still at its default. An explicit `dep-dirs` (even one
 * that turns out to be wrong) is the author having thought about it, and an
 * install that is only `npm ci` writes nowhere else to lose.
 */
export function installSkipOutputWarning(
  commands: readonly string[],
  depDirs: readonly string[],
): string | null {
  if (!isDefaultDepDirs(depDirs)) return null;
  const steps = nonDependencyInstallSteps(commands);
  if (steps.length === 0) return null;
  return (
    `[install] skipped (marker matched), but agent.install runs a step that is not a plain ` +
    `dependency install: ${steps.map((s) => `\`${s}\``).join(", ")}. ` +
    `A replacement container restores only the declared agent.dep-dirs ` +
    `(${DEFAULT_DEP_DIRS.join(", ")}) — anything else that step wrote, if gitignored, is not ` +
    `in this container. If the session needs it, add its directory to agent.dep-dirs in shipit.yaml.`
  );
}
