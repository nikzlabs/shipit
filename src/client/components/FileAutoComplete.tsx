import { useState, useEffect, useRef, useCallback } from "react";
import type { FileTreeNode } from "../../server/types.js";

export interface FileAutoCompleteProps {
  /** The current query text (after the @). */
  query: string;
  /** Flat list of file tree nodes to search through. */
  fileTree: FileTreeNode[];
  /** Called when the user selects a file. */
  onSelect: (filePath: string) => void;
  /** Called when the autocomplete should be dismissed. */
  onDismiss: () => void;
  /** Position hint for the popup (pixels from bottom of viewport). */
  anchorBottom?: number;
}

/** Recursively flatten a FileTreeNode[] into a list of file paths. */
function flattenTree(nodes: FileTreeNode[]): string[] {
  const result: string[] = [];
  function walk(list: FileTreeNode[]) {
    for (const node of list) {
      if (node.type === "file") {
        result.push(node.path);
      }
      if (node.children) {
        walk(node.children);
      }
    }
  }
  walk(nodes);
  return result;
}

/** Filter file paths by a query string (case-insensitive substring match). */
function filterFiles(allFiles: string[], query: string): string[] {
  if (!query) return allFiles.slice(0, 20);
  const lower = query.toLowerCase();
  return allFiles.filter((f) => f.toLowerCase().includes(lower)).slice(0, 20);
}

export function FileAutoComplete({
  query,
  fileTree,
  onSelect,
  onDismiss,
}: FileAutoCompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const allFiles = flattenTree(fileTree);
  const matches = filterFiles(allFiles, query);

  // Reset selected index when matches change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, matches.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (matches.length > 0) {
          onSelect(matches[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    },
    [matches, selectedIndex, onSelect, onDismiss],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (matches.length === 0) {
    return (
      <div
        className="absolute bottom-full left-0 right-0 mb-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg z-20 p-2 text-xs text-gray-500"
        data-testid="file-autocomplete"
      >
        No matching files
      </div>
    );
  }

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto"
      data-testid="file-autocomplete"
      ref={listRef}
    >
      {matches.map((filePath, i) => (
        <button
          key={filePath}
          className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors ${
            i === selectedIndex
              ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200"
              : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          }`}
          onClick={() => onSelect(filePath)}
          onMouseEnter={() => setSelectedIndex(i)}
          data-testid="file-autocomplete-item"
        >
          <svg className="w-3.5 h-3.5 shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          <span className="truncate">{filePath}</span>
        </button>
      ))}
    </div>
  );
}
