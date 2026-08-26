/**
 * Install-failure diagnostics (extracted from `session-worker.ts` so the pure
 * formatting is unit-testable without importing the heavy worker module).
 *
 * Background: a non-zero `agent.install` command used to surface only as
 * `Command "npm install" exited with code 1` — the exit code but never the
 * cause. The original incident (a recreated session whose root-owned workspace
 * made `npm install` fail fast with EACCES) showed up downstream merely as a
 * stale `install_ok=false`, with the actual `EACCES … permission denied` line
 * lost in the emit-only `install_log` stream. Capturing a bounded stderr tail
 * and folding it into the failure message makes the failure self-diagnosing.
 */

/**
 * Max bytes of an install command's stderr retained for the failure message.
 * Bounded so a chatty installer can't grow the retained result without limit;
 * the tail carries the actionable cause, so we keep the END.
 */
export const INSTALL_STDERR_TAIL_BYTES = 4096;

/**
 * Compose the `install_error` message for a non-zero install command: the
 * command + exit code, plus the last few non-empty stderr lines when present.
 * Pure so it can be unit-tested without spawning a process.
 */
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

/**
 * The `install_error` message for an install whose commands all exited 0 but
 * left a declared dep dir present-and-EMPTY (docs/272 — the post-install half of
 * the dep-dir contradiction check).
 *
 * The gate that starts `x-shipit-depends-on-install` services keys on the
 * install's `ok`, and `ok` was the exit status alone. An exit status is easy to
 * launder — the incident that prompted this ran
 * `npm ci … || [ -x game/node_modules/.bin/vite ]`, so a failed `npm ci` exited
 * 0, ShipIt stamped the install marker, and the gate opened over a dep tree that
 * had never been built. The services then crash-looped on a missing module,
 * five retries deep, with `install finished` as the only thing in the log.
 *
 * Naming the dirs matters more than the wording: the actionable fact is WHICH
 * declaration the install did not satisfy, because the two ways out are fixing
 * the install command and narrowing `agent.dep-dirs` — and only the user knows
 * which of those is true for their repo.
 */
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

/**
 * The advisory note for an install that exited 0 and left a declared dep dir
 * empty **because npm hoisted its package's dependencies elsewhere**
 * (planning#480).
 *
 * Deliberately NOT phrased as a misconfiguration to fix. Declaring a workspace's
 * `node_modules` is legitimate and forward-looking: the moment a version
 * conflict forces npm to build a nested tree there, the declaration is what gets
 * that tree overlay-backed. The note exists so that an empty declared dir is
 * never accepted *silently* — the breadcrumb matters if a gated service later
 * fails looking for something in it — not to push the user into editing
 * `shipit.yaml`.
 *
 * Streamed to `install_log` rather than raised as `install_error`, and only once
 * the install has passed every other check, since the wording asserts success.
 */
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

/**
 * The `install_error` message for an install whose commands all exited 0 but
 * left a declared dep dir holding a tree that does not match its
 * `package-lock.json` (nikzlabs#2496 — the STALE half of the same gate
 * {@link formatEmptyDepDirsFailureMessage} covers the empty half of).
 *
 * The wording differs from the empty case in one way that matters: an empty dir
 * has two plausible causes (a failed install, or a `dep-dirs` entry this repo
 * does not produce), so that message offers both remedies. A tree that npm
 * itself recorded as holding different versions than the lockfile asks for has
 * only one — the install did not run to completion. Naming the packages is what
 * makes that checkable at a glance instead of taken on trust.
 */
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
