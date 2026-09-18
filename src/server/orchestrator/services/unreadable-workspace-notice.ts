import type { UnreadableWorkspace } from "../../shared/git.js";
import { redactSecretsInText } from "../../shared/secret-scan.js";

// Derive committed from the returned hash: an omitted directory does not imply a commit exists.
export function formatUnreadableWorkspaceNotice(
  unreadable: UnreadableWorkspace,
  opts: { committed: boolean; what?: string },
): string {
  const what = opts.what ?? "This turn";
  const cause =
    "A service in your `docker-compose.yml` running as its own `user:` is the usual cause; "
    + "gitignoring that path removes the problem entirely.";

  if (unreadable.kind === "omitted" && opts.committed) {
    return (
      `This commit is short. ShipIt could not read \`${unreadable.detail}\` in your workspace, `
      + `so its contents were left out of the commit — everything else was committed normally. ${cause}`
    );
  }
  if (unreadable.kind === "omitted") {
    return (
      `${what} produced NO commit. ShipIt could not read \`${unreadable.detail}\` in your `
      + "workspace, so anything inside it is invisible to git and is not on the branch — and "
      + `nothing was committed this time round. ${cause}`
    );
  }
  return (
    `${what} was NOT committed. ShipIt could not read \`${unreadable.detail}\`, and \`git add\` `
    + "stages nothing at all when that happens — so the rest of the work is still in the "
    + "working tree, uncommitted. Fix that path's permissions (or gitignore it) and the next turn "
    + "will commit everything."
  );
}

export function formatUncommittedTurnNotice(reason: string, what = "This turn"): string {
  const trimmed = redactSecretsInText(reason.trim()).slice(0, 600);
  return (
    `${what} was NOT committed — ShipIt's auto-commit failed, so the work is still in the `
    + "working tree and is not on the branch. git said:\n\n"
    + `\`\`\`\n${trimmed}\n\`\`\`\n\n`
    + "The files are untouched. Resolving whatever git is reporting above (or asking the agent "
    + "to commit by hand) lets the next turn commit everything."
  );
}
