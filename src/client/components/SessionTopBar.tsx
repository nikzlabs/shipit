import { useState, useRef, useCallback } from "react";
import { DotsThreeVerticalIcon, DownloadSimpleIcon, PencilSimpleIcon, ArchiveIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.js";

interface SessionTopBarProps {
  title: string;
  onRename: (title: string) => void;
  onDownloadChat: () => void;
  onArchive: () => void;
}

export function SessionTopBar({ title, onRename, onDownloadChat, onArchive }: SessionTopBarProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editResolvedRef = useRef(false);

  const startEditing = useCallback(() => {
    setEditingTitle(title);
    editResolvedRef.current = false;
    setIsEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [title]);

  const submitRename = useCallback(() => {
    if (editResolvedRef.current) return;
    editResolvedRef.current = true;
    const trimmed = editingTitle.trim();
    if (trimmed && trimmed !== title) {
      onRename(trimmed);
    }
    setIsEditing(false);
    setEditingTitle("");
  }, [editingTitle, title, onRename]);

  const cancelEditing = useCallback(() => {
    editResolvedRef.current = true;
    setIsEditing(false);
    setEditingTitle("");
  }, []);

  return (
    <div className="flex items-center justify-between px-4 h-10 border-b border-(--color-border-primary)">
      {/* Left: session title (inline editable) */}
      <div className="flex-1 min-w-0 mr-2">
        {isEditing ? (
          <form onSubmit={(e) => { e.preventDefault(); submitRename(); }} className="flex-1 min-w-0">
            <input
              ref={inputRef}
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEditing(); }}
              onBlur={submitRename}
              className="w-full bg-(--color-bg-tertiary) text-(--color-text-primary) text-sm px-2 py-0.5 rounded border border-(--color-border-secondary) focus:border-(--color-border-focus) focus:outline-none"
              maxLength={120}
            />
          </form>
        ) : (
          <button
            onClick={startEditing}
            className="text-sm font-medium text-(--color-text-primary) truncate block max-w-full text-left hover:text-(--color-text-link) transition-colors cursor-text"
            title="Click to rename"
          >
            {title}
          </button>
        )}
      </div>

      {/* Right: overflow menu */}
      <div className="shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
              title="Session actions"
              aria-label="Session actions"
            >
              <DotsThreeVerticalIcon size={ICON_SIZE.SM} weight="bold" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={startEditing}>
              <PencilSimpleIcon size={ICON_SIZE.SM} />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDownloadChat}>
              <DownloadSimpleIcon size={ICON_SIZE.SM} />
              Download chat
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onArchive}>
              <ArchiveIcon size={ICON_SIZE.SM} />
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
