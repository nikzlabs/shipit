import { useState, useRef, useCallback } from "react";
import { ArrowCounterClockwiseIcon, DotsThreeVerticalIcon, DownloadSimpleIcon, MagnifyingGlassIcon, PencilSimpleIcon, ArchiveIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.js";
import { AutoMergeToggle } from "./PrStatusControls.js";
import type { PrCardState } from "../stores/pr-store.js";

interface SessionTopBarProps {
  sessionId: string;
  title: string;
  canAutoMerge?: boolean;
  autoMerge?: PrCardState["autoMerge"];
  onRename: (title: string) => void;
  onDownloadChat: () => void;
  onArchive: () => void;
  onSearch: () => void;
  recoverRewindAvailable?: boolean;
  onRecoverRewind?: () => void;
}

export function SessionTopBar({
  sessionId,
  title,
  canAutoMerge,
  autoMerge,
  onRename,
  onDownloadChat,
  onArchive,
  onSearch,
  recoverRewindAvailable,
  onRecoverRewind,
}: SessionTopBarProps) {
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

      {/* Right: search + overflow menu */}
      <div className="shrink-0 flex items-center gap-1">
        <button
          onClick={onSearch}
          className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
          title="Search conversation"
          aria-label="Search conversation"
        >
          <MagnifyingGlassIcon size={ICON_SIZE.SM} weight="bold" />
        </button>
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
            {canAutoMerge && (
              <div className="px-2 py-1">
                <AutoMergeToggle sessionId={sessionId} autoMerge={autoMerge} />
              </div>
            )}
            {recoverRewindAvailable && (
              <DropdownMenuItem onSelect={onRecoverRewind}>
                <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} />
                Recover recent rewind
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={startEditing}>
              <PencilSimpleIcon size={ICON_SIZE.SM} />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDownloadChat}>
              <DownloadSimpleIcon size={ICON_SIZE.SM} />
              Download chat
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onArchive}>
              <ArchiveIcon size={ICON_SIZE.SM} />
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
