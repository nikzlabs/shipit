// eslint-disable-next-line no-restricted-imports -- useEffect: document.body style during drag (DOM sync)
import { useState, useRef, useEffect, useCallback } from "react";
import { ArchiveIcon as PhArchiveIcon, ArrowCounterClockwiseIcon, GearSixIcon, GithubLogoIcon, PlusIcon, SidebarSimpleIcon, CheckCircleIcon, XCircleIcon, CircleNotchIcon, WrenchIcon } from "@phosphor-icons/react";
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
  repoLabel?: string;
  disabled?: boolean;
}

/** Returns the highest-priority attention reason for a session, or null if no attention needed. */
function useAttentionInfo(sessionId: string): string | null {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));

  const checks = card?.checks;
  const autoFix = card?.autoFix;
  const autoMerge = card?.autoMerge;
  const prState = status?.prState;
  const mergeable = status?.mergeable;

  // No attention needed while the agent is working
  if (isAgentRunning) return null;

  // Priority 1: CI failed, auto-fix not running
  if (checks?.state === "failure" && autoFix?.status !== "running") {
    if (autoFix?.status === "exhausted") {
      return "CI fix failed after 3 attempts";
    }
    return "CI checks failed";
  }

  // Priority 2: Merge conflicts (mergeable can be boolean | undefined, so === false is intentional)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
  if (prState === "open" && mergeable === false) {
    return "PR has merge conflicts";
  }

  // Priority 3: Auto-merge error
  if (autoMerge?.error) {
    return "Auto-merge needs repo configuration";
  }

  // Priority 4: PR merged/closed — no action needed
  if (prState === "merged" || prState === "closed") return null;

  // Agent is idle and session is not resolved — user needs to act
  return "Waiting for your input";
}

/** Consolidated status dot replacing separate AgentDot + CiDot. */
function SessionStatusDot({ sessionId }: { sessionId: string }) {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));

  const checks = card?.checks;
  const autoFix = card?.autoFix;

  // Priority 1: CI failed + needs manual fix (auto-fix not running)
  if (checks?.state === "failure" && autoFix?.status !== "running") {
    return <span className="shrink-0 text-(--color-error) flex" title={`CI failed ${checks.failed} of ${checks.total}`}><XCircleIcon size={ICON_SIZE.XS} /></span>;
  }

  // Priority 2: Merge conflict / merge error — handled by attention border, but show warning icon
  // (we reuse the attention condition check inline)

  // Priority 3: Auto-fix running
  if (autoFix?.status === "running") {
    return <span className="shrink-0 text-(--color-autofix) flex" title="Auto-fix running"><WrenchIcon size={ICON_SIZE.XS} className="animate-spin" /></span>;
  }

  // Priority 4: Agent running
  if (isAgentRunning) {
    return <span className="w-2 h-2 rounded-full bg-(--color-success) animate-pulse shrink-0" title="Agent running" />;
  }

  // Priority 5: CI pending
  if (checks?.state === "pending") {
    return <span className="shrink-0 text-(--color-warning) flex" title={`CI running ${checks.passed}/${checks.total}`}><CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" /></span>;
  }

  // Priority 6: CI passed
  if (checks?.state === "success") {
    return <span className="shrink-0 text-(--color-success) flex" title={`CI passed ${checks.total}/${checks.total}`}><CheckCircleIcon size={ICON_SIZE.XS} /></span>;
  }

  // Priority 7: idle / no data
  return null;
}

export function SessionItem({ session, isCurrent, onResume, onArchive, onRestore, repoLabel, disabled }: SessionItemProps) {
  const isArchived = session.archived === true;

  const attentionReason = useAttentionInfo(session.id);
  const needsAttention = attentionReason !== null && !isArchived;

  return (
    <div
      className={`group flex items-start gap-1.5 px-2 py-1.5 text-xs transition-colors rounded mx-1 ${
        needsAttention ? "border border-(--color-attention)" : "border border-transparent"
      } ${
        isArchived ? "opacity-60" : ""
      } ${
        isCurrent
          ? "bg-(--color-bg-secondary) text-(--color-text-primary)"
          : isArchived
            ? "text-(--color-text-tertiary) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)"
            : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
      }`}
      title={attentionReason ?? undefined}
    >
      <PrStateBadge sessionId={session.id} />

      <button
        onClick={() => { if (!isCurrent) onResume(session.id); }}
        disabled={disabled}
        className="flex-1 min-w-0 text-left"
      >
        <p className="truncate leading-snug">{session.title}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <SessionStatusDot sessionId={session.id} />
          {repoLabel && (
            <span className="text-[10px] text-(--color-text-tertiary) truncate">{repoLabel}</span>
          )}
          {isArchived && <PhArchiveIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary) shrink-0" />}
          <span className="text-(--color-text-tertiary) text-[10px]">{formatRelativeDate(session.lastUsedAt)}</span>
        </div>
      </button>

      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isArchived && onRestore && (
            <Button
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); onRestore(session.id); }}
              disabled={disabled}
              className="p-1! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-success)"
              title="Restore session"
            >
              <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} />
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
  onOpenRepoSwitcher,
  onNewSession,
  collapsed,
  onToggleCollapse,
}: SessionSidebarProps) {
  const { width, isDragging, onMouseDown } = useSidebarResize();

  // Filter sessions to active repo, sorted most-recently-used first
  const filteredSessions = (activeRepoUrl
    ? sessions.filter((s) => s.remoteUrl === activeRepoUrl)
    : sessions.filter((s) => !s.remoteUrl)
  ).sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));

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
          <GithubLogoIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0" />
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
        <GithubLogoIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0" />
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
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-0.5">
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
            />
          ))
        )}
      </div>

      {/* New Session button */}
      <div className="shrink-0 border-t border-(--color-border-primary) px-3 py-3">
        <Button
          variant="ghost"
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
