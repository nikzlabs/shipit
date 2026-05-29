/**
 * Builds the chat-visible warning shown when `GitManager.autoCommit` excludes
 * files containing git conflict markers from the post-turn commit. Shared so
 * both the WS path (`post-turn.ts`) and the system-turn path
 * (`dispatched-turn.ts`) produce the same message.
 */
export function formatConflictMarkerNotice(skippedConflictedFiles: string[]): string {
  if (skippedConflictedFiles.length === 0) {
    throw new Error("formatConflictMarkerNotice: skippedConflictedFiles must be non-empty");
  }
  const list = skippedConflictedFiles.map((p) => `\`${p}\``).join(", ");
  const noun = skippedConflictedFiles.length === 1 ? "file" : "files";
  return (
    `Skipped auto-commit for ${noun} containing git conflict markers: ${list}. ` +
    `Resolve the markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) and the next turn will commit them.`
  );
}
