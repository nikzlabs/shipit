// eslint-disable-next-line no-restricted-imports -- useEffect: focus input on edit start + click-outside listener for dropdown
import { useState, useRef, useEffect, useCallback } from "react";
import { DotsThreeVerticalIcon, DownloadSimpleIcon, PencilSimpleIcon, ArchiveIcon, RocketIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

interface SessionTopBarProps {
  title: string;
  onRename: (title: string) => void;
  onDownloadChat: () => void;
  onArchive: () => void;
  onDeploy?: () => void;
  isMobile?: boolean;
}

export function SessionTopBar({ title, onRename, onDownloadChat, onArchive, onDeploy, isMobile }: SessionTopBarProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editResolvedRef = useRef(false);

  // Focus & select on edit start
  useEffect(() => {
    if (isEditing && inputRef.current) {
      editResolvedRef.current = false;
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const startEditing = useCallback(() => {
    setEditingTitle(title);
    setIsEditing(true);
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
    <div className="flex items-center justify-between px-4 py-2 border-b border-(--color-border-primary) min-h-[40px]">
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
      <div ref={menuRef} className="relative shrink-0">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
          title="Session actions"
          aria-label="Session actions"
        >
          <DotsThreeVerticalIcon size={ICON_SIZE.SM} weight="bold" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-48 bg-(--color-bg-elevated) border border-(--color-border-primary) rounded-lg shadow-lg z-50 py-1">
            <button
              onClick={() => { setMenuOpen(false); startEditing(); }}
              className="w-full text-left px-3 py-2 text-xs text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) transition-colors flex items-center gap-2"
            >
              <PencilSimpleIcon size={ICON_SIZE.SM} />
              Rename
            </button>
            <button
              onClick={() => { setMenuOpen(false); onDownloadChat(); }}
              className="w-full text-left px-3 py-2 text-xs text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) transition-colors flex items-center gap-2"
            >
              <DownloadSimpleIcon size={ICON_SIZE.SM} />
              Download chat
            </button>
            {isMobile && onDeploy && (
              <button
                onClick={() => { setMenuOpen(false); onDeploy(); }}
                className="w-full text-left px-3 py-2 text-xs text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) transition-colors flex items-center gap-2"
              >
                <RocketIcon size={ICON_SIZE.SM} />
                Deploy
              </button>
            )}
            <button
              onClick={() => { setMenuOpen(false); onArchive(); }}
              className="w-full text-left px-3 py-2 text-xs text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) transition-colors flex items-center gap-2"
            >
              <ArchiveIcon size={ICON_SIZE.SM} />
              Archive
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
