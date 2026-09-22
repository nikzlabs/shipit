import type { CommitHookFailure } from "../../shared/git.js";
import { COMMIT_HOOK_TIMEOUT_MS } from "../../shared/git.js";

/**
 * A hook may not cost the turn its work
 * (docs/266-orchestrator-git-trust-boundary req 10), so this normally reports a
 * commit that landed. `committed: false` is the one case ShipIt cannot fix: a
 * hook that empties the working tree itself leaves nothing to commit, and
 * saying "committed" there would be a lie the user cannot check.
 */
export function formatCommitHookNotice(
  failure: CommitHookFailure,
  opts: { committed: boolean; timeoutMs?: number },
): string {
  const seconds = Math.round((opts.timeoutMs ?? COMMIT_HOOK_TIMEOUT_MS) / 1000);
  const headline = failure.kind === "timeout"
    ? `A git hook in this project did not finish within ${String(seconds)}s, so ShipIt stopped it.`
    : "A git hook in this project failed.";
  const outcome = opts.committed
    ? "**The turn's work is committed anyway, without hooks** — a hook is not allowed to leave it "
      + "uncommitted, because uncommitted work has no reflog entry and no way back."
    : "**Nothing was committed**, because the hook left nothing in the working tree to commit. "
      + "Check what the hook did to your files before running another turn.";
  const output = failure.output.trim();
  const said = output
    ? `\n\nThe hook said:\n\n\`\`\`\n${output}\n\`\`\``
    : "\n\nThe hook printed nothing.";
  return `${headline} ${outcome}${said}`;
}
