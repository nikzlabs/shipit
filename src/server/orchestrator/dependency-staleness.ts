export type DependencyGapReason = "not-content-keyed" | "install-failed";

export interface DependencyGap {
  reason: DependencyGapReason;
  rewrite?: string;
  commands: string[];
}

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

function renderCommands(commands: string[]): string {
  return commands.length === 0 ? "    —" : commands.map((c) => `    ${c}`).join("\n");
}

const CONSEQUENCE =
  "Installed dependencies may no longer match the code on disk. A service can keep " +
  "reporting `running` while every request fails on an unresolvable import, and " +
  "restarting it does not help — the usual compose guard is " +
  "`[ -d node_modules ] || npm ci`, and the directory exists. It just holds the " +
  "pre-rewrite contents.";

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
          "Re-run it now:",
          "",
          renderCommands(gap.commands),
          "",
          "To have ShipIt check this itself, list the files the install consumes under " +
            "`agent.install-inputs` in `shipit.yaml`.",
        ];

  return [...head, "", CONSEQUENCE, "", ...tail].join("\n");
}

export function dependencyGapSummary(gap: DependencyGap): string {
  const where = rewritePhrase(gap.rewrite);
  return gap.reason === "install-failed"
    ? `\`agent.install\` failed after ${where}, so installed dependencies may not match this tree. ` +
        "A service may run while every request fails on an unresolvable import."
    : `\`agent.install\` was not re-run after ${where} — ShipIt cannot tell which files it ` +
        "consumes, so installed dependencies may not match this tree. A service may run while " +
        "every request fails on an unresolvable import; re-run the install before reading that " +
        "as a code fault.";
}

export function dependencyGapAgentPrefix(gap: DependencyGap | null | undefined): string {
  if (!gap) return "";
  const where = rewritePhrase(gap.rewrite);
  const cause =
    gap.reason === "install-failed"
      ? `ShipIt rewrote this session's working tree (${where}) and re-ran \`agent.install\`, which FAILED.`
      : `ShipIt rewrote this session's working tree (${where}) and did NOT re-run \`agent.install\`, ` +
        "because its commands are not a recognized dependency install and ShipIt cannot tell which " +
        "files they consume.";

  return [
    `[System] ${cause} The dependencies installed in this container may not match the code now ` +
      "on disk. Run this session's install commands before you treat any unresolved-import, " +
      "missing-module or missing-binary error as a fault in the code:",
    "",
    renderCommands(gap.commands),
    "",
    "Restarting the service does not fix it: the usual compose guard is " +
      "`[ -d node_modules ] || npm ci`, and the directory exists — it just holds the pre-rewrite " +
      "contents. A service can keep reporting `running` while every request it serves fails.",
  ].join("\n");
}
