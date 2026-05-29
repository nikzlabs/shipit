/**
 * Builds the chat-visible warning shown when `GitManager.autoCommit` refuses
 * to commit because git reports an in-progress merge/rebase. Shared so both
 * the WS path (`post-turn.ts`) and the system-turn path
 * (`dispatched-turn.ts`) produce the same message.
 */
export function formatUnresolvedConflictNotice(args: {
  conflictedFiles: string[];
  rebaseInProgress: boolean;
}): string {
  const { conflictedFiles, rebaseInProgress } = args;
  if (conflictedFiles.length === 0 && !rebaseInProgress) {
    throw new Error(
      "formatUnresolvedConflictNotice: at least one of conflictedFiles / rebaseInProgress must be set",
    );
  }
  if (conflictedFiles.length > 0) {
    const list = conflictedFiles.map((p) => `\`${p}\``).join(", ");
    const noun = conflictedFiles.length === 1 ? "an unresolved conflict" : "unresolved conflicts";
    return (
      `Skipped auto-commit — git reports ${noun} in ${list}. ` +
      `Resolve the conflict${conflictedFiles.length === 1 ? "" : "s"} and the next turn will commit the working tree.`
    );
  }
  return (
    `Skipped auto-commit — a git rebase is in progress. ` +
    `Finish or abort the rebase and the next turn will commit the working tree.`
  );
}
