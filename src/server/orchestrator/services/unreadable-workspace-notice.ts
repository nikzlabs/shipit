import type { UnreadableWorkspace } from "../../shared/git.js";
import { redactSecretsInText } from "../../shared/secret-scan.js";

/**
 * docs/266-orchestrator-git-trust-boundary reqs 14 + 15 / planning#407 — the user-facing words for a commit that
 * ShipIt's own git could not read the whole workspace for.
 *
 * Lifted out of `ws-handlers/post-turn.ts` because the post-turn commit is not
 * the only commit ShipIt makes on a session's behalf: an agent-driven
 * `gh pr create` flush, a late sub-agent consult, a UI file save and the
 * fallback turn-commit path all run the same `autoCommit` and all used to
 * destructure the result WITHOUT `unreadable` — so the same measured states
 * were reported on one path and silent on the others (review finding).
 *
 * The two kinds get deliberately different words, which is why docs/266 states
 * them as two requirements and not one: `omitted` is a commit that exists and
 * is short, `blocked` is a commit that does not exist at all. One vague notice
 * covering both would serve neither.
 *
 * `what` names the piece of work that is short or missing, so the same facts
 * read correctly whether the caller is a turn ("This turn"), a mid-turn flush
 * or a UI file save.
 *
 * `committed` is not cosmetic and every caller must pass it honestly. An
 * `omitted` result does NOT imply a commit: when the unreadable directory hides
 * the only changes git can see, `autoCommit` takes its clean-tree return with a
 * null hash — and so do the conflict and secret refusals. Assuming a commit
 * there told the user "this commit is short… everything else was committed
 * normally" when nothing had been committed at all, which is the *other*
 * requirement's outcome wearing this one's words (review finding). Callers all
 * have the hash in hand, so this is `commitHash !== null`, never a default.
 */
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

/**
 * docs/266-orchestrator-git-trust-boundary req 15 — the words for an auto-commit that failed for a reason
 * ShipIt could NOT classify.
 *
 * Requirement 15 is unconditional: a turn whose work was not committed at all
 * must be reported to the user, naming what blocked it, and "a log line is not
 * a report". The permission case has tailored advice above; everything else —
 * an EIO, a file deleted between `status` and `add`, a full disk, an
 * `index.lock` left by a killed git — reaches the user through this instead of
 * through an unhandled rejection that `postTurnStep` turns into a log line
 * nobody reads.
 *
 * Deliberately quotes git's own message rather than guessing at a cause. This
 * is the path that runs when the message did NOT match anything we recognize,
 * so any interpretation offered here would be invention. The quote is redacted
 * (docs/213) and length-bounded before it is persisted: it is arbitrary text
 * from a failing command, and a remote URL carrying a token is exactly the
 * shape of thing that ends up in one.
 */
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
