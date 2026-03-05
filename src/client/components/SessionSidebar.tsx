// eslint-disable-next-line no-restricted-imports -- useEffect: document.body style during drag, input focus on editing start (DOM sync)
import { useState, useRef, useEffect, useCallback } from "react";
import { PencilSimpleIcon, ArchiveIcon as PhArchiveIcon, GearSixIcon, GithubLogoIcon, PlusIcon, SidebarSimpleIcon, CheckCircleIcon, XCircleIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { formatRelativeDate } from "../utils/dates.js";
import { Button } from "./ui/button.js";
import { PrStateBadge } from "./PrLifecycleCard.js";
import { useSessionStore } from "../stores/session-store.js";
import { usePrStore } from "../stores/pr-store.js";
import type { SessionInfo } from "../../server/shared/types.js";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 240;
const SIDEBAR_STORAGE_KEY = "sidebar-width";

function loadSidebarWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (v !== null) {
      const n = parseInt(v, 10);
      if (!Number.isNaN(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n;
    }
  } catch { /* ignore */ }
  return SIDEBAR_DEFAULT;
}

function useSidebarResize() {
  const [width, setWidth] = useState(loadSidebarWidth);
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startWidth = widthRef.current;

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + ev.clientX - startX));
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      try { localStorage.setItem(SIDEBAR_STORAGE_KEY, widthRef.current.toString()); } catch { /* ignore */ }
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    } else {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
  }, [isDragging]);

  return { width, isDragging, onMouseDown };
}

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

export interface SessionItemProps {
  session: SessionInfo;
  isCurrent: boolean;
  onResume: (id: string) => void;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  repoLabel?: string;
  disabled?: boolean;
}

function AgentDot({ sessionId }: { sessionId: string }) {
  const isActive = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  if (!isActive) return null;
  return <span className="w-2 h-2 rounded-full bg-(--color-success) animate-pulse shrink-0" title="Agent running" />;
}

function CiDot({ sessionId }: { sessionId: string }) {
  const checks = usePrStore((s) => s.cardBySession[sessionId]?.checks);
  if (!checks || checks.state === "none") return null;
  if (checks.state === "success") {
    return <span className="shrink-0 text-(--color-success) flex" title={`CI passed ${checks.total}/${checks.total}`}><CheckCircleIcon size={12} /></span>;
  }
  if (checks.state === "failure") {
    return <span className="shrink-0 text-(--color-error) flex" title={`CI failed ${checks.failed} of ${checks.total}`}><XCircleIcon size={12} /></span>;
  }
  return <span className="shrink-0 text-(--color-warning) flex" title={`CI running ${checks.passed}/${checks.total}`}><CircleNotchIcon size={12} className="animate-spin" /></span>;
}

export function SessionItem({ session, isCurrent, onResume, onArchive, onRestore, onRename, repoLabel, disabled }: SessionItemProps) {
  const isArchived = session.archived === true;
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
      onRename?.(session.id, editingTitle.trim());
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
          : isArchived
            ? "text-(--color-text-tertiary) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)"
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
          disabled={disabled}
          className="flex-1 min-w-0 text-left"
        >
          <p className="truncate leading-snug">{session.title}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <AgentDot sessionId={session.id} />
            <CiDot sessionId={session.id} />
            {repoLabel && (
              <span className="text-[10px] text-(--color-text-tertiary) truncate">{repoLabel}</span>
            )}
            <span className="text-(--color-text-tertiary) text-[10px]">{formatRelativeDate(session.lastUsedAt)}</span>
          </div>
        </button>
      )}

      {!isEditing && (
        <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onRename && (
            <Button
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); startEditing(); }}
              className="p-1! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-text-link)"
              title="Rename session"
            >
              <PencilSimpleIcon size={ICON_SIZE.SM} />
            </Button>
          )}
          {isArchived && onRestore && (
            <Button
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); onRestore(session.id); }}
              disabled={disabled}
              className="p-1! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-success)"
              title="Restore session"
            >
              <PhArchiveIcon size={ICON_SIZE.SM} />
            </Button>
          )}
          {!isArchived && onArchive && (
            <Button
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); onArchive(session.id); }}
              disabled={disabled}
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
  const { width, isDragging, onMouseDown } = useSidebarResize();

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
    <div className="flex h-full shrink-0 min-h-0">
    <div className="flex flex-col h-full bg-(--color-bg-primary) border-r border-(--color-border-primary) min-h-0" style={{ width }}>
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
    {/* Resize handle — overlaid on top of the border */}
    <div
      onMouseDown={onMouseDown}
      className={`resize-handle shrink-0 -ml-2 ${isDragging ? "resize-handle--active" : ""}`}
    />
    </div>
  );
}
