// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown listener + DOM scrollIntoView (browser API subscriptions with cleanup)
import { useState, useEffect, useRef, useCallback } from "react";
import { FileIcon } from "@phosphor-icons/react";
import { PopoverContent } from "./ui/popover.js";
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
  /** Uploaded file paths (e.g. "/uploads/data.csv") to include in autocomplete. */
  uploadPaths?: string[];
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
  uploadPaths = [],
}: FileAutoCompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const allFiles = [...flattenTree(fileTree), ...uploadPaths];
  const matches = filterFiles(allFiles, query);

  // Reset selected index when query changes (inline state reset during render)
  const prevQueryRef = useRef(query);
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query;
    setSelectedIndex(0);
  }

  const scrollSelectedIntoView = useCallback((index: number) => {
    const el = listRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.min(prev + 1, matches.length - 1);
          scrollSelectedIntoView(next);
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = Math.max(prev - 1, 0);
          scrollSelectedIntoView(next);
          return next;
        });
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
    [matches, selectedIndex, onSelect, onDismiss, scrollSelectedIntoView],
  );

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (matches.length === 0) {
    return (
      <PopoverContent
        side="top"
        align="start"
        className="p-2 text-xs text-(--color-text-secondary)"
        style={{ width: "var(--radix-popover-trigger-width)" }}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        data-testid="file-autocomplete"
      >
        No matching files
      </PopoverContent>
    );
  }

  return (
    <PopoverContent
      side="top"
      align="start"
      className="max-h-48 overflow-y-auto p-0"
      style={{ width: "var(--radix-popover-trigger-width)" }}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
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
    </PopoverContent>
  );
}
