import { CaretRightIcon, CaretDownIcon, FolderIcon, FolderOpenIcon, FileIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { statusIcon, statusColor, type FileTreeNode } from "./diff-utils.js";

export interface DiffTreeNodeProps {
  node: FileTreeNode;
  depth: number;
  selectedFileIndex: number;
  onSelect: (idx: number) => void;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
}

/** Renders a single node in the diff file tree. */
export function DiffTreeNode({
  node,
  depth,
  selectedFileIndex,
  onSelect,
  expandedDirs,
  onToggleDir,
}: DiffTreeNodeProps) {
  const isDir = !!node.children;

  if (isDir) {
    // Build a stable key from the dir name path
    const fullDirKey = `dir:${depth}:${node.name}`;
    const expanded = expandedDirs.has(fullDirKey);

    return (
      <>
        <div
          className="flex items-center gap-1 px-2 py-0.5 text-xs cursor-pointer text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => onToggleDir(fullDirKey)}
        >
          {expanded
            ? <CaretDownIcon size={10} className="shrink-0" />
            : <CaretRightIcon size={10} className="shrink-0" />
          }
          {expanded
            ? <FolderOpenIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
            : <FolderIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
          }
          <span className="truncate">{node.name}</span>
          <span className="ml-auto shrink-0 flex gap-1 text-[10px]">
            {node.insertions > 0 && <span className="text-(--color-success)">+{node.insertions}</span>}
            {node.deletions > 0 && <span className="text-(--color-error)">-{node.deletions}</span>}
          </span>
        </div>
        {expanded && node.children!.map((child, i) => (
          <DiffTreeNode
            key={child.path ?? `${child.name}-${i}`}
            node={child}
            depth={depth + 1}
            selectedFileIndex={selectedFileIndex}
            onSelect={onSelect}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
          />
        ))}
      </>
    );
  }

  // File leaf
  const isSelected = node.fileIndex === selectedFileIndex;
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-0.5 text-xs cursor-pointer transition-colors ${
        isSelected
          ? "bg-(--color-accent-subtle) text-(--color-text-primary)"
          : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
      }`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={() => onSelect(node.fileIndex!)}
    >
      <span className={`shrink-0 font-mono text-[10px] font-bold ${statusColor(node.status!)}`}>
        {statusIcon(node.status!)}
      </span>
      <FileIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
      <span className="truncate" title={node.path}>
        {node.name}
      </span>
      <span className="ml-auto shrink-0 flex gap-1 text-[10px]">
        {node.insertions > 0 && <span className="text-(--color-success)">+{node.insertions}</span>}
        {node.deletions > 0 && <span className="text-(--color-error)">-{node.deletions}</span>}
      </span>
    </div>
  );
}
