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
    <div className="mt-1 flex items-center gap-2 text-xs font-mono text-gray-400">
      <span className="text-gray-500">{isWrite ? "write" : "edit"}</span>
      <span className="text-gray-300 truncate">{sessionRelativePath(filePath)}</span>
      <span className="flex items-center gap-1.5 ml-auto shrink-0">
        {added > 0 && <span className="text-green-400">+{added}</span>}
        {removed > 0 && <span className="text-red-400">-{removed}</span>}
        {added === 0 && removed === 0 && <span className="text-gray-500 italic">no changes</span>}
      </span>
    </div>
  );
}
