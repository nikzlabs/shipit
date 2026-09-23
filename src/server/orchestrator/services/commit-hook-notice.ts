import type { CommitHookFailure } from "../../shared/git.js";
import { COMMIT_HOOK_TIMEOUT_MS } from "../../shared/git.js";

/**
 * A hook may not cost the turn its work
 * (docs/266-orchestrator-git-trust-boundary req 10), so a returned failure
 * always has a commit behind it: the one case ShipIt cannot commit — a hook
 * that stashes or reverts the tree — throws out of `autoCommit` instead, and
 * is reported as an uncommitted turn (req 15).
 */
export function formatCommitHookNotice(
  failure: CommitHookFailure,
  opts: { timeoutMs?: number } = {},
): string {
  const seconds = Math.round((opts.timeoutMs ?? COMMIT_HOOK_TIMEOUT_MS) / 1000);
  const headline = failure.kind === "timeout"
    ? `A git hook in this project did not finish within ${String(seconds)}s, so ShipIt stopped it.`
    : "A git hook in this project failed.";
  const outcome =
    "**The turn's work is committed anyway, without hooks** — a hook is not allowed to leave it "
    + "uncommitted, because uncommitted work has no reflog entry and no way back.";
  const output = failure.output.trim();
  const said = output
    ? `\n\nThe hook said:\n\n\`\`\`\n${output}\n\`\`\``
    : "\n\nThe hook printed nothing.";
  return `${headline} ${outcome}${said}`;
}
