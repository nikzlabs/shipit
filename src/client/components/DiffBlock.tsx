/**
 * DiffBlock — renders inline file change diffs in the chat.
 *
 * Supports two modes:
 * - Edit: shows old_string (red, prefixed with -) vs new_string (green, prefixed with +)
 * - Write: shows the written content as all-green additions
 */

export interface DiffBlockProps {
  filePath: string;
  oldString?: string;
  newString?: string;
  /** When true, the entire content is a new file write (no old content). */
  isWrite?: boolean;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  // Split but preserve trailing empty line awareness
  return text.split("\n");
}

export function DiffBlock({ filePath, oldString, newString, isWrite }: DiffBlockProps) {
  const removedLines = splitLines(oldString ?? "");
  const addedLines = splitLines(newString ?? "");

  return (
    <div className="mt-2 rounded-md overflow-hidden border border-gray-700 text-xs font-mono">
      {/* File header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 text-gray-300 border-b border-gray-700">
        <span className="text-gray-500">{isWrite ? "write" : "edit"}</span>
        <span className="font-semibold text-gray-200 truncate">{filePath}</span>
      </div>

      {/* Diff body */}
      <div className="bg-gray-950 overflow-x-auto max-h-64 overflow-y-auto">
        {/* Removed lines (only for edits) */}
        {!isWrite &&
          removedLines.map((line, i) => (
            <div key={`r-${i}`} className="flex">
              <span className="select-none w-6 text-right pr-1 text-red-700 bg-red-950/40 shrink-0">-</span>
              <pre className="px-2 text-red-400 bg-red-950/20 flex-1 whitespace-pre-wrap break-all">{line}</pre>
            </div>
          ))}

        {/* Separator between removed and added */}
        {!isWrite && removedLines.length > 0 && addedLines.length > 0 && (
          <div className="border-t border-gray-800" />
        )}

        {/* Added lines */}
        {addedLines.map((line, i) => (
          <div key={`a-${i}`} className="flex">
            <span className="select-none w-6 text-right pr-1 text-green-700 bg-green-950/40 shrink-0">+</span>
            <pre className="px-2 text-green-400 bg-green-950/20 flex-1 whitespace-pre-wrap break-all">{line}</pre>
          </div>
        ))}

        {/* Fallback for empty diffs */}
        {removedLines.length === 0 && addedLines.length === 0 && (
          <div className="px-3 py-2 text-gray-500 italic">No content changes</div>
        )}
      </div>
    </div>
  );
}
