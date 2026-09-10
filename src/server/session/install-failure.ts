export const INSTALL_STDERR_TAIL_BYTES = 4096;

export function formatInstallFailureMessage(
  command: string,
  exitCode: number,
  stderrTail: string,
): string {
  const base = `Command "${command}" exited with code ${exitCode}`;
  const tail = stderrTail
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-6)
    .join("\n");
  return tail ? `${base}\n${tail}` : base;
}

export function formatEmptyDepDirsFailureMessage(depDirs: string[]): string {
  const list = depDirs.join(", ");
  const plural = depDirs.length === 1 ? "" : "s";
  return (
    `agent.install exited 0 but left declared dep dir${plural} empty: ${list}. ` +
    `Treating the install as failed: a dep dir that holds nothing cannot start ` +
    `the services gated on it, and would be published as an empty shared base. ` +
    `Either the install command did not really succeed (a "|| true"-style ` +
    `fallback can hide a non-zero exit), or agent.dep-dirs in shipit.yaml ` +
    `declares a directory this install does not produce.`
  );
}

// Emit only after all install checks pass; hoisting does not invalidate a dep-dir declaration.
export function formatHoistedDepDirsWarning(depDirs: string[]): string {
  const list = depDirs.join(", ");
  const plural = depDirs.length === 1 ? "" : "s";
  const is = depDirs.length === 1 ? "is" : "are";
  return (
    `[install] accepted empty declared dep dir${plural}: ${list}. ` +
    `npm's own record (.package-lock.json) links th${plural ? "ese" : "is"} package${plural} ` +
    `into an ancestor node_modules and records no nested tree, so the ` +
    `dependencies ${is} installed — just not there. The install succeeded.`
  );
}

export function formatStaleDepDirsFailureMessage(
  stale: { depDir: string; mismatches: { packagePath: string; expected: string; found: string | null }[] }[],
  maxExamples: number,
): string {
  const list = stale.map((s) => s.depDir).join(", ");
  const plural = stale.length === 1 ? "" : "s";
  const all = stale.flatMap((s) => s.mismatches);
  const examples = all
    .slice(0, maxExamples)
    .map(
      (m) =>
        `${m.packagePath}: lockfile wants ${m.expected}, tree has ${m.found ?? "nothing"}`,
    )
    .join("; ");
  const more = all.length > maxExamples ? ` (+${all.length - maxExamples} more)` : "";
  return (
    `agent.install exited 0 but left declared dep dir${plural} out of date with ` +
    `package-lock.json: ${list}. npm's own record of what it installed ` +
    `(.package-lock.json inside the dep dir) still describes a different tree — ` +
    `${examples}${more}. Treating the install as failed: the services gated on ` +
    `the install would start against dependencies the lockfile does not ask for. ` +
    `The install did not really succeed — a "|| true"-style fallback can hide a ` +
    `non-zero exit — so read the install log for the first error it swallowed.`
  );
}
