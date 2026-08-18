/**
 * nikzlabs/shipit#2429 — what to say when an orchestrator-side tree rewrite could
 * NOT leave the session's dependencies verified.
 *
 * `workspace-rewrite.ts` re-checks dependencies after every rewrite ShipIt
 * performs from outside the container, and for the common case that is the whole
 * answer: the worker's content-keyed install marker either matches (a fast skip)
 * or misses (a reinstall). Two paths reach neither outcome, and both used to end
 * in a silent `return`:
 *
 *   - **`not-content-keyed`** — the session declares an `agent.install` whose
 *     commands are not a recognized pure dependency install (a codegen step, a
 *     shell script), so `resolveDepsHashInputs` yields no input set. Its deps
 *     hash can never match the marker, which means an auto-reinstall would
 *     reinstall from scratch on every rewrite; #1622's documented safe default is
 *     therefore not to. The tree still moved, so the dependencies may still be
 *     stale.
 *   - **`install-failed`** — the re-run happened and did not succeed.
 *
 * Silence there costs exactly what the issue reported. `node_modules` keeps the
 * pre-rewrite tree, the dev server starts fine and then fails every request with
 * `Failed to resolve import`, `shipit service list` still says `running`, and the
 * only evidence is a service log that reads like a code error — so the natural
 * first guess is that the rewrite brought in a broken commit. Nothing anywhere
 * connects the failure to the tree movement, and a restart does not help because
 * the usual compose guard is `[ -d node_modules ] || npm ci` and the directory
 * exists; it is just the wrong contents.
 *
 * A failed install already latches `dependsOnInstall` services to `error`, but
 * that covers only gated services and does not name the tree movement as the
 * cause — which is the fact the person diagnosing it is missing.
 *
 * This module is pure text. It holds no state and reaches nothing: the runner
 * owns the gap (`ContainerSessionRunner`), and the two surfaces render what is
 * here — a persisted transcript notice for the user, and a line alongside
 * `shipit service list` / `GET /api/sessions/:id/services` for the agent that is
 * looking at the failing service.
 */

/** Why the dependencies could not be verified after the rewrite. */
export type DependencyGapReason = "not-content-keyed" | "install-failed";

/** A session's unverified-dependency state — `null` when there is nothing to say. */
export interface DependencyGap {
  reason: DependencyGapReason;
  /**
   * The `onWorkspaceRewritten` label of the rewrite that moved the tree
   * (`rebase`, `rollback`, …). Absent when the trigger was an in-container edit
   * the file watcher reported rather than a rewrite ShipIt performed.
   */
  rewrite?: string;
  /** `agent.install` as declared — the remedy to name. */
  commands: string[];
}

/**
 * The rewrite label, in words a person reads.
 *
 * The labels are the caller identifiers `onWorkspaceRewritten` already takes, so
 * they are stable, and an unmapped one degrades to the generic phrase rather
 * than leaking `pre-turn-reset` into the transcript.
 */
export function rewritePhrase(rewrite: string | undefined): string {
  switch (rewrite) {
    case "rebase": return "a sync onto the latest base";
    case "rebase-abort": return "an aborted rebase";
    case "rollback": return "a rollback";
    case "rewind": return "a rewind";
    case "git-pull": return "a git pull";
    case "session-merge": return "a merge of another session's branch";
    case "reset-to-base": return "a branch reset onto the base";
    case "pre-turn-reset": return "an automatic reset of this merged branch";
    case "release-prepare": return "a release prepare";
    case undefined: return "a change to its dependency files";
    default: return "a working-tree rewrite";
  }
}

/** Render the declared install commands, one indented line each. */
function renderCommands(commands: string[]): string {
  return commands.length === 0 ? "    —" : commands.map((c) => `    ${c}`).join("\n");
}

/** The shared consequence — the sentence that connects a tree movement to the symptom. */
const CONSEQUENCE =
  "Installed dependencies may no longer match the code on disk. A service can keep " +
  "reporting `running` while every request fails on an unresolvable import, and " +
  "restarting it does not help — the usual compose guard is " +
  "`[ -d node_modules ] || npm ci`, and the directory exists. It just holds the " +
  "pre-rewrite contents.";

/**
 * The transcript notice. Persisted, because the whole failure is one nobody can
 * reconstruct later: it names what moved the tree, why the dependencies were not
 * re-checked, the command to run now, and the one-line config change that lets
 * ShipIt do the check itself next time.
 */
export function dependencyGapNotice(gap: DependencyGap): string {
  const where = rewritePhrase(gap.rewrite);
  const head =
    gap.reason === "install-failed"
      ? [
          `ShipIt rewrote this session's working tree (${where}) and re-ran ` +
            "`agent.install`, which **failed**.",
        ]
      : [
          `ShipIt rewrote this session's working tree (${where}) and did **not** ` +
            "re-run `agent.install`.",
          "",
          "ShipIt re-runs it automatically when it can tell which files the install " +
            "consumes. This one's commands are not a recognized dependency install, so " +
            "it cannot — and re-running it on every rewrite would mean a full rebuild " +
            "each time.",
        ];

  const tail =
    gap.reason === "install-failed"
      ? ["Re-run it once the failure is fixed:", "", renderCommands(gap.commands)]
      : [
          "Re-run it if imports start failing:",
          "",
          renderCommands(gap.commands),
          "",
          "To have ShipIt check this itself, list the files the install consumes under " +
            "`agent.install-inputs` in `shipit.yaml`.",
        ];

  return [...head, "", CONSEQUENCE, "", ...tail].join("\n");
}

/**
 * The one-line form carried alongside the service list.
 *
 * Deliberately a complete sentence rather than a status word: it lands next to a
 * service the agent is already reading as `running`, and the whole point is that
 * the row itself cannot be trusted to explain the failure.
 */
export function dependencyGapSummary(gap: DependencyGap): string {
  const where = rewritePhrase(gap.rewrite);
  return gap.reason === "install-failed"
    ? `\`agent.install\` failed after ${where}, so installed dependencies may not match this tree. ` +
        "A service may run while every request fails on an unresolvable import."
    : `\`agent.install\` was not re-run after ${where} — ShipIt cannot tell which files it ` +
        "consumes, so installed dependencies may not match this tree. A service may run while " +
        "every request fails on an unresolvable import; re-run the install if that happens.";
}
