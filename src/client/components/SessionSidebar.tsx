import { useState, useRef, useEffect } from "react";
import { PencilSimpleIcon, ArchiveIcon as PhArchiveIcon, GearSixIcon, GithubLogoIcon, PlusIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { formatRelativeDate } from "../utils/dates.js";
import { Button } from "./ui/button.js";
import { PrStateBadge } from "./PrLifecycleCard.js";
import { useSessionStore } from "../stores/session-store.js";
import type { SessionInfo } from "../../server/shared/types.js";

export type { SessionInfo };

interface SessionSidebarProps {
  sessions: SessionInfo[];
  activeRepoUrl: string | undefined;
  activeRepoName: string;
  activeRepoStatus?: "cloning" | "ready";
  currentSessionId: string | undefined;
  onResume: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onOpenRepoSwitcher: () => void;
  onNewSession: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

interface SessionItemProps {
  session: SessionInfo;
  isCurrent: boolean;
  onResume: (id: string) => void;
  onArchive: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

function SessionItem({ session, isCurrent, onResume, onArchive, onRename }: SessionItemProps) {
  const [editingTitle, setEditingTitle] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editResolvedRef = useRef(false);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      editResolvedRef.current = false;
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const startEditing = () => {
    setEditingTitle(session.title);
    setIsEditing(true);
  };

  const submitRename = () => {
    if (editResolvedRef.current) return;
    editResolvedRef.current = true;
    if (editingTitle.trim()) {
      onRename(session.id, editingTitle.trim());
    }
    setIsEditing(false);
    setEditingTitle("");
  };

  const cancelEditing = () => {
    editResolvedRef.current = true;
    setIsEditing(false);
    setEditingTitle("");
  };

  return (
    <div
      className={`group flex items-start gap-1.5 px-2 py-1.5 text-xs transition-colors rounded mx-1 ${
        isCurrent
          ? "bg-(--color-bg-secondary) text-(--color-text-primary)"
          : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
      }`}
    >
      <PrStateBadge sessionId={session.id} />

      {isEditing ? (
        <form
          className="flex-1 min-w-0"
          onSubmit={(e) => { e.preventDefault(); submitRename(); }}
        >
          <input
            ref={inputRef}
            type="text"
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") cancelEditing(); }}
            onBlur={submitRename}
            className="w-full bg-(--color-bg-tertiary) text-(--color-text-primary) text-xs px-1.5 py-0.5 rounded border border-(--color-border-secondary) focus:border-(--color-border-focus) focus:outline-none"
            maxLength={120}
          />
        </form>
      ) : (
        <button
          onClick={() => { if (!isCurrent) onResume(session.id); }}
          className="flex-1 min-w-0 text-left"
        >
          <p className="truncate leading-snug">{session.title}</p>
          <p className="text-(--color-text-tertiary) text-[10px] mt-0.5">{formatRelativeDate(session.lastUsedAt)}</p>
        </button>
      )}

      {!isEditing && (
        <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            onClick={(e) => { e.stopPropagation(); startEditing(); }}
            className="p-1! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-text-link)"
            title="Rename session"
          >
            <PencilSimpleIcon size={ICON_SIZE.SM} />
          </Button>
          {!isCurrent && (
            <Button
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); onArchive(session.id); }}
              className="p-1! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-warning)"
              title="Archive session"
            >
              <PhArchiveIcon size={ICON_SIZE.SM} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionSidebar({
  sessions,
  activeRepoUrl,
  activeRepoName,
  activeRepoStatus,
  currentSessionId,
  onResume,
  onArchive,
  onRename,
  onOpenRepoSwitcher,
  onNewSession,
  collapsed,
  onToggleCollapse,
}: SessionSidebarProps) {
  // Filter sessions to active repo
  const filteredSessions = activeRepoUrl
    ? sessions.filter((s) => s.remoteUrl === activeRepoUrl)
    : sessions.filter((s) => !s.remoteUrl);

  if (collapsed) {
    return (
      <div className="flex flex-col w-10 h-full shrink-0 bg-(--color-bg-primary) border-r border-(--color-border-primary) items-center py-2 gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          className="p-0! w-6 h-6"
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <SidebarSimpleIcon size={ICON_SIZE.SM} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenRepoSwitcher}
          className="p-0! w-6 h-6 text-(--color-text-secondary) hover:text-(--color-text-primary)"
          title={activeRepoName || "Select repository"}
          aria-label="Repository"
        >
          <GithubLogoIcon size={ICON_SIZE.SM} className="shrink-0" />
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewSession}
          disabled={!activeRepoUrl || activeRepoStatus === "cloning"}
          className="p-0! w-6 h-6 text-(--color-success) hover:text-(--color-success)"
          title="New Session"
          aria-label="New Session"
        >
          <PlusIcon size={ICON_SIZE.SM} />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-60 h-full shrink-0 bg-(--color-bg-primary) border-r border-(--color-border-primary) min-h-0">
      {/* Active repo header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-(--color-border-primary) shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          className="p-0! w-6 h-6 text-(--color-text-tertiary)"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <SidebarSimpleIcon size={ICON_SIZE.SM} />
        </Button>
        <GithubLogoIcon size={ICON_SIZE.SM} className="shrink-0" />
        <span className="flex-1 min-w-0 truncate text-xs font-medium text-(--color-text-primary)">
          {activeRepoName || "No repository"}
        </span>
        {activeRepoStatus === "cloning" && (
          <span className="shrink-0 text-[9px] text-(--color-warning) animate-pulse">cloning</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenRepoSwitcher}
          className="p-0! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-text-primary)"
          title="Change repository"
          aria-label="Change repository"
        >
          <GearSixIcon size={ICON_SIZE.SM} />
        </Button>
      </div>

      {/* Scrollable sessions area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Sessions header */}
        <div className="flex items-center justify-between px-3 py-2 sticky top-0 bg-(--color-bg-primary) z-10">
          <span className="text-xs font-semibold text-(--color-text-secondary) tracking-wide">Sessions</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useSessionStore.getState().setAllSessionsDialogOpen(true)}
            className="text-[10px] text-(--color-text-tertiary) hover:text-(--color-text-primary) px-1 py-0.5"
          >
            View All
          </Button>
        </div>

        {filteredSessions.length === 0 ? (
          <p className="text-xs text-(--color-text-tertiary) px-3 py-4 text-center">No sessions yet.</p>
        ) : (
          filteredSessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isCurrent={s.id === currentSessionId}
              onResume={onResume}
              onArchive={onArchive}
              onRename={onRename}
            />
          ))
        )}
      </div>

      {/* New Session button */}
      <div className="shrink-0 border-t border-(--color-border-primary) px-3 py-3">
        <Button
          variant="primary"
          onClick={onNewSession}
          disabled={!activeRepoUrl || activeRepoStatus === "cloning"}
          className="w-full justify-center gap-2"
        >
          <PlusIcon size={14} />
          New Session
        </Button>
      </div>
    </div>
  );
}
