import type { SecretFinding } from "../../shared/secret-scan.js";
import type { UnreadableWorkspace } from "../../shared/git.js";

export type EvictBlockReason =
  | { kind: "secret"; findings: SecretFinding[] }
  | { kind: "conflict"; conflictedFiles: string[]; rebaseInProgress: boolean }
  | { kind: "no-repository" }
  | { kind: "unreadable"; unreadable: UnreadableWorkspace }
  | { kind: "unknown" };

export function formatEvictBlockedNotice(reason: EvictBlockReason): string {
  const preserved =
    "Your uncommitted changes are still on disk and were not touched — ShipIt will keep this "
    + "session's checkout until the work can be committed and pushed. Cached dependencies are "
    + "not held back, so opening the session may reinstall them.";

  if (reason.kind === "secret") {
    const noun = reason.findings.length === 1
      ? "a likely secret"
      : `${reason.findings.length} likely secrets`;
    const lines = reason.findings.map((f) => {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      return `- \`${where}\` — ${f.description} (\`${f.redacted}\`)`;
    });
    return (
      `🔒 Disk cleanup paused for this session — the auto-commit that runs before idle `
      + `cleanup found ${noun} in your uncommitted changes:\n\n`
      + `${lines.join("\n")}\n\n`
      + `${preserved}\n\n`
      + `Remove the secret (use an environment variable or a ShipIt secret instead) — or add a `
      + `\`gitleaks:allow\` comment to the line if it's a false positive — and the next turn will `
      + `commit and push normally.`
    );
  }

  if (reason.kind === "no-repository") {
    return (
      "⚠️ Disk cleanup paused for this session — its workspace is no longer a git repository "
      + "(the `.git` directory is missing), so ShipIt cannot commit, push, or restore it.\n\n"
      + "The files in the workspace are still on disk and were not touched. They exist only "
      + "here, though: with no repository there is no branch or commit to push them to, so "
      + "automatic cleanup will keep skipping this session and its checkout will keep using "
      + "disk. Cached dependencies are not held back, so opening the session may reinstall them."
      + "\n\nOpen the session to copy out anything you still need, then archive it to free the "
      + "space."
    );
  }

  if (reason.kind === "unreadable") {
    const missed = reason.unreadable.kind === "omitted"
      ? "so its contents are left out of every commit ShipIt makes"
      : "and `git add` stages nothing at all when that happens, so none of this session's "
        + "uncommitted work can be committed";
    return (
      `⚠️ Disk cleanup paused for this session — ShipIt could not read \`${reason.unreadable.detail}\` `
      + `in your workspace, ${missed}.\n\n`
      // Unreadable files may already be pushed; their uniqueness cannot be checked.
      + "Those files are still on disk and were not touched. ShipIt cannot check whether they "
      + "exist anywhere else, so it will not delete this checkout — which means the session keeps "
      + "using disk until the path is readable. Cached dependencies are not held back, so opening "
      + "the session may reinstall them.\n\n"
      + "A service in your `docker-compose.yml` running as its own `user:` is the usual cause. "
      + "Fix that path's permissions — or gitignore it, if it is throwaway data like a database "
      + "volume — and a later cleanup pass will reclaim the space on its own. Archiving the "
      + "session does not free it: the same check runs there, so the checkout is kept until "
      + "the path can be read."
    );
  }

  if (reason.kind === "conflict") {
    const detail = [
      reason.rebaseInProgress ? "a rebase is in progress" : "",
      reason.conflictedFiles.length > 0
        ? `unmerged paths: ${reason.conflictedFiles.map((f) => `\`${f}\``).join(", ")}`
        : "",
    ].filter(Boolean).join("; ");
    return (
      `⚠️ Disk cleanup paused for this session — the auto-commit that runs before idle cleanup `
      + `was refused because the checkout is in an unresolved merge state`
      + `${detail ? ` (${detail})` : ""}.\n\n`
      + `${preserved}\n\n`
      + `Resolve the conflict (or abort the rebase) and the next turn will commit and push normally.`
    );
  }

  return (
    `⚠️ Disk cleanup paused for this session — the auto-commit that runs before idle cleanup `
    + `did not produce a commit, so the uncommitted changes could not be pushed anywhere safe.\n\n`
    + `${preserved}\n\n`
    + `Open the session and commit or discard the changes to let it be cleaned up.`
  );
}
