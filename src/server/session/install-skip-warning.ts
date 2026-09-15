// A restored checkout can match its install marker while lacking generated output.
// This command heuristic misses lifecycle-script builds; it does not inspect disk.

import { depInputsForCommand } from "../shared/deps-hash.js";
import { DEFAULT_DEP_DIRS } from "../shared/shipit-config.js";

function isDefaultDepDirs(depDirs: readonly string[]): boolean {
  return (
    depDirs.length === DEFAULT_DEP_DIRS.length &&
    depDirs.every((d, i) => d === DEFAULT_DEP_DIRS[i])
  );
}

export function nonDependencyInstallSteps(commands: readonly string[]): string[] {
  return commands.filter((c) => depInputsForCommand(c) === null);
}

export function installSkipOutputWarning(
  commands: readonly string[],
  depDirs: readonly string[],
  absentDepDirs: readonly string[] = [],
): string | null {
  const steps = nonDependencyInstallSteps(commands);
  if (steps.length === 0) return null;
  // A declared dir that is absent after a skip is the one shape the custom-dep-dirs bail-out
  // must not swallow: the repo did name it, and the step that fills it did not run (docs/183).
  if (absentDepDirs.length > 0) {
    return (
      `[install] skipped (marker matched), but ${absentDepDirs.length} declared agent.dep-dirs ` +
      `entr${absentDepDirs.length === 1 ? "y is" : "ies are"} not present in this workspace: ` +
      `${absentDepDirs.join(", ")}. agent.install runs a step that is not a plain dependency ` +
      `install (${steps.map((s) => `\`${s}\``).join(", ")}), and a skip cannot have produced ` +
      `those directories. Treat anything they should contain as missing.`
    );
  }
  if (!isDefaultDepDirs(depDirs)) return null;
  return (
    `[install] skipped (marker matched), but agent.install runs a step that is not a plain ` +
    `dependency install: ${steps.map((s) => `\`${s}\``).join(", ")}. ` +
    `What a skip guarantees is the committed files plus the declared agent.dep-dirs ` +
    `(${DEFAULT_DEP_DIRS.join(", ")}) — so if this checkout did not run that step itself, ` +
    `whatever it wrote outside those, and git ignores, is not here. If the session needs it, ` +
    `add its directory to agent.dep-dirs in shipit.yaml.`
  );
}
