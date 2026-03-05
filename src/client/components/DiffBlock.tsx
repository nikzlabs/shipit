/**
 * DiffBlock — renders a compact inline file change summary in the chat.
 *
 * Shows a one-line summary with the file path and a colored diff stat
 * like "+40 -12" (green for additions, red for removals).
 */

import { sessionRelativePath } from "../path-utils.js";

export interface DiffBlockProps {
  filePath: string;
  oldString?: string;
  newString?: string;
  /** When true, the entire content is a new file write (no old content). */
  isWrite?: boolean;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export function DiffBlock({ filePath, oldString, newString, isWrite }: DiffBlockProps) {
  const removed = countLines(oldString ?? "");
  const added = countLines(newString ?? "");

  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-mono text-(--color-text-tertiary)">
      <span className="text-(--color-text-secondary)">{isWrite ? "write" : "edit"}</span>
      <span className="text-(--color-text-primary) truncate">{sessionRelativePath(filePath)}</span>
      <span className="flex items-center gap-1.5 ml-auto shrink-0">
        {added > 0 && <span className="text-(--color-success)">+{added}</span>}
        {removed > 0 && <span className="text-(--color-error)">-{removed}</span>}
        {added === 0 && removed === 0 && <span className="text-(--color-text-secondary) italic">no changes</span>}
      </span>
    </div>
  );
}
