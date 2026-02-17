import { useState, useCallback } from "react";
import type { FileTreeNode } from "../../server/types.js";

export type { FileTreeNode };

export interface FileTreeProps {
  tree: FileTreeNode[];
  onRefresh: () => void;
  onFileClick?: (filePath: string) => void;
  selectedFile?: string | null;
}

/** Icon for collapsed directory */
function FolderClosedIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
  );
}

/** Icon for expanded directory */
function FolderOpenIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
    </svg>
  );
}

/** Icon for files */
function FileIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

/** Chevron arrow for expand/collapse */
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-3 h-3 shrink-0 text-gray-500 transition-transform ${expanded ? "rotate-90" : ""}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

function TreeNode({
  node,
  depth,
  onFileClick,
  selectedFile,
}: {
  node: FileTreeNode;
  depth: number;
  onFileClick?: (filePath: string) => void;
  selectedFile?: string | null;
}) {
  const [expanded, setExpanded] = useState(depth < 1);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const paddingLeft = depth * 16 + 8;

  if (node.type === "directory") {
    return (
      <div>
        <button
          onClick={toggle}
          className="flex items-center gap-1.5 w-full text-left py-1 px-2 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm text-gray-700 dark:text-gray-300"
          style={{ paddingLeft }}
        >
          <ChevronIcon expanded={expanded} />
          {expanded ? <FolderOpenIcon /> : <FolderClosedIcon />}
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeNode key={child.path} node={child} depth={depth + 1} onFileClick={onFileClick} selectedFile={selectedFile} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isSelected = selectedFile === node.path;

  return (
    <button
      onClick={() => onFileClick?.(node.path)}
      className={`flex items-center gap-1.5 w-full text-left py-1 px-2 text-sm transition-colors ${
        isSelected
          ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200"
          : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
      }`}
      style={{ paddingLeft: paddingLeft + 16 }}
      title={node.path}
    >
      <FileIcon />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function FileTree({ tree, onRefresh, onFileClick, selectedFile }: FileTreeProps) {
  if (tree.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <div className="text-center space-y-2">
          <div className="text-2xl">&#128193;</div>
          <p>No files in /workspace yet.</p>
          <p className="text-xs text-gray-400 dark:text-gray-600">
            Ask the agent to create a project to get started.
          </p>
          <button
            onClick={onRefresh}
            className="mt-2 px-3 py-1 text-xs rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b border-gray-300 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium text-gray-700 dark:text-gray-300">Files</span>
        <button
          onClick={onRefresh}
          className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
          title="Refresh file tree"
        >
          Reload
        </button>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto py-1">
        {tree.map((node) => (
          <TreeNode key={node.path} node={node} depth={0} onFileClick={onFileClick} selectedFile={selectedFile} />
        ))}
      </div>
    </div>
  );
}
