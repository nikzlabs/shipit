import { useState, useCallback } from "react";
import { FolderIcon, FolderOpenIcon, FileIcon, CaretRightIcon, PlusIcon, FolderSimpleIcon, ArrowClockwiseIcon, UploadSimpleIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import type { FileTreeNode } from "../../server/shared/types.js";
import type { UploadItem } from "../hooks/useFileUpload.js";

export type { FileTreeNode };

export interface FileTreeProps {
  tree: FileTreeNode[];
  onRefresh: () => void;
  onFileClick?: (filePath: string) => void;
  selectedFile?: string | null;
  onAddToChat?: (filePath: string) => void;
  onDownload?: (filePath: string) => void;
  uploads?: UploadItem[];
}

function TreeNode({
  node,
  depth,
  onFileClick,
  selectedFile,
  onAddToChat,
  onDownload,
}: {
  node: FileTreeNode;
  depth: number;
  onFileClick?: (filePath: string) => void;
  selectedFile?: string | null;
  onAddToChat?: (filePath: string) => void;
  onDownload?: (filePath: string) => void;
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
          className="flex items-center gap-1.5 w-full text-left py-1 px-2 hover:bg-(--color-bg-hover) transition-colors text-sm text-(--color-text-primary)"
          style={{ paddingLeft }}
        >
          <CaretRightIcon size={12} className={`shrink-0 text-(--color-text-tertiary) transition-transform ${expanded ? "rotate-90" : ""}`} />
          {expanded ? (
            <FolderOpenIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0 text-(--color-folder)" />
          ) : (
            <FolderIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0 text-(--color-folder)" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeNode key={child.path} node={child} depth={depth + 1} onFileClick={onFileClick} selectedFile={selectedFile} onAddToChat={onAddToChat} onDownload={onDownload} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isSelected = selectedFile === node.path;

  return (
    <div
      className={`group flex items-center py-1 px-2 text-sm transition-colors ${
        isSelected
          ? "bg-(--color-accent-subtle) text-(--color-text-link)"
          : "text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
      }`}
      style={{ paddingLeft: paddingLeft + 16 }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-shipit-file", JSON.stringify({
          path: node.path,
        }));
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <button
        onClick={() => onFileClick?.(node.path)}
        className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        title={node.path}
      >
        <FileIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary)" />
        <span className="truncate">{node.name}</span>
      </button>
      {onDownload && (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onDownload(node.path);
          }}
          className="hidden group-hover:inline-flex w-5 h-5 shrink-0 ml-1 text-(--color-text-secondary) hover:text-(--color-text-link)"
          title="Download file"
          aria-label={`Download ${node.name}`}
        >
          <DownloadSimpleIcon size={12} />
        </Button>
      )}
      {onAddToChat && (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onAddToChat(node.path);
          }}
          className="hidden group-hover:inline-flex w-5 h-5 shrink-0 ml-1 text-(--color-text-secondary) hover:text-(--color-text-link)"
          title="Add to chat context"
          aria-label={`Add ${node.name} to chat`}
        >
          <PlusIcon size={12} />
        </Button>
      )}
    </div>
  );
}

export function FileTree({ tree, onRefresh, onFileClick, selectedFile, onAddToChat, onDownload, uploads }: FileTreeProps) {
  if (tree.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-(--color-text-secondary) text-sm">
        <div className="text-center space-y-2">
          <FolderSimpleIcon size={ICON_SIZE.LG} className="mx-auto text-(--color-text-tertiary)" />
          <p>No files in /workspace yet.</p>
          <p className="text-xs text-(--color-text-tertiary)">
            Ask the agent to create a project to get started.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            className="mt-2"
          >
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-(--color-bg-secondary) border-b border-(--color-border-secondary) text-xs text-(--color-text-secondary)">
        <span className="font-medium text-(--color-text-primary)">Files</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          className="shrink-0"
          title="Refresh file tree"
        >
          <ArrowClockwiseIcon size={ICON_SIZE.SM} />
        </Button>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto py-1">
        {tree.map((node) => (
          <TreeNode key={node.path} node={node} depth={0} onFileClick={onFileClick} selectedFile={selectedFile} onAddToChat={onAddToChat} onDownload={onDownload} />
        ))}

        {/* Uploads section */}
        {uploads && uploads.length > 0 && (
          <div className="mt-2 border-t border-(--color-border-secondary) pt-1">
            <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-(--color-text-secondary)">
              <UploadSimpleIcon size={ICON_SIZE.SM} className="shrink-0" />
              <span>Uploads</span>
            </div>
            {uploads.filter((u) => u.status === "ready" && u.path).map((u) => (
              <div
                key={u.id}
                className="group flex items-center py-1 px-2 text-sm text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
                style={{ paddingLeft: 24 }}
              >
                <span className="flex items-center gap-1.5 flex-1 min-w-0 truncate" title={u.path}>
                  <FileIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-text-tertiary)" />
                  {u.name}
                </span>
                {onAddToChat && u.path && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onAddToChat(u.path!)}
                    className="hidden group-hover:inline-flex w-5 h-5 shrink-0 ml-1 text-(--color-text-secondary) hover:text-(--color-text-link)"
                    title="Add to chat context"
                    aria-label={`Add ${u.name} to chat`}
                  >
                    <PlusIcon size={12} />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
