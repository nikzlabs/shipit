// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown listener + DOM scrollIntoView (browser API subscriptions with cleanup)
import { useState, useEffect, useRef, useCallback } from "react";
import { FileIcon } from "@phosphor-icons/react";
import type { FileTreeNode } from "../../server/shared/types.js";

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

  // Reset selected index when query changes (inline state reset during render)
  const prevQueryRef = useRef(query);
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query;
    setSelectedIndex(0);
  }

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
        className="absolute bottom-full left-0 right-0 mb-1 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded-lg shadow-lg z-20 p-2 text-xs text-(--color-text-secondary)"
        data-testid="file-autocomplete"
      >
        No matching files
      </div>
    );
  }

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto"
      data-testid="file-autocomplete"
      ref={listRef}
    >
      {matches.map((filePath, i) => (
        <button
          key={filePath}
          className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors ${
            i === selectedIndex
              ? "bg-(--color-accent-subtle) text-(--color-text-link)"
              : "text-(--color-text-primary) hover:bg-(--color-bg-hover)"
          }`}
          onClick={() => onSelect(filePath)}
          onMouseEnter={() => setSelectedIndex(i)}
          data-testid="file-autocomplete-item"
        >
          <FileIcon size={14} className="shrink-0 text-(--color-text-secondary)" />
          <span className="truncate">{filePath}</span>
        </button>
      ))}
    </div>
  );
}
