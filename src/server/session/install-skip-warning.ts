/**
 * Skip-time warning for install output no `dep-dirs` entry covers (planning#2315).
 *
 * A matching marker can describe a checkout that never ran the install. Two
 * paths reach it: a workspace reclaimed for disk and re-cloned from the bare
 * cache (`disk-utils.ts` `REGENERABLE_SESSION_SUBDIRS`), and a container whose
 * overlay dep dirs all hit an already-published base for this HEAD, which is
 * pre-stamped with a marker the gate accepts (`overlay-session.ts`
 * `preStampInstallMarker`). Either way the clone holds the committed files and
 * the declared dep dirs, `agent.install` does not run, and anything else it once
 * wrote — a gitignored `dist/`, a generated client — is not there, while every
 * activation surface reports the install done.
 *
 * An ordinary idle recreate does NOT do this: the host clone is a durable mount,
 * so its gitignored output is still in place. That is exactly what makes the
 * failure hard — it looks intermittent while being deterministic per path. This
 * is the log line that names it.
 *
 * **The signal is a guess, and stays cheap on purpose.** We cannot know what an
 * install writes without running it, so the check is the same allowlist the
 * content-keyed skip already uses (`depInputsForCommand`): a command that is not
 * a recognized *pure dependency install* probably writes something else. Paired
 * with `dep-dirs` left at its default, that is very likely wrong — but a false
 * positive (a build whose output is committed, or which the session never needs)
 * must cost one line in the install log, never a session. So this warns and
 * changes nothing: it never blocks, never re-runs the install, and never fails.
 * For the same reason the message says the output *may* be missing rather than
 * asserting it is: this module knows what the install DECLARES, never what the
 * clone holds.
 *
 * **Known gap, deliberate: a build hidden in a `postinstall` / `prepare`.**
 * `npm ci` alone is classified pure, so a lifecycle script that builds slips
 * through, and the loss there is identical. `plugin-dep-store.ts` rejects that
 * pattern for the plugin store, and the same test here would be two lines. It is
 * not applied because `prepare` is the near-universal husky hook: the warning
 * would then fire on most repositories that resume, on every skip, forever, and
 * a warning everyone learns to ignore does not make this failure visible — which
 * is the only thing it is for. The `shipit-yaml.md` § Install behavior bullet
 * states the guarantee for every repo and does not depend on this firing.
 *
 * It fires at **skip time** rather than when the config is read. At config-read
 * time on the first container the install is about to run and the output will be
 * present, so the warning would be noise on a session that is working; the skip
 * is the exact moment the output can be missing, and it sits beside the one
 * other check that distrusts a matching marker (`overlay-dep-check.ts`).
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
    `What a skip guarantees is the committed files plus the declared agent.dep-dirs ` +
    `(${DEFAULT_DEP_DIRS.join(", ")}) — so if this checkout did not run that step itself, ` +
    `whatever it wrote outside those, and git ignores, is not here. If the session needs it, ` +
    `add its directory to agent.dep-dirs in shipit.yaml.`
  );
}
