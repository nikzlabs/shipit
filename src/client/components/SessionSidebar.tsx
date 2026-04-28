// eslint-disable-next-line no-restricted-imports -- useEffect: document.body style during drag (DOM sync)
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ArchiveIcon as PhArchiveIcon, ArrowCounterClockwiseIcon, GithubLogoIcon, PlusIcon, SidebarSimpleIcon, CheckCircleIcon, XCircleIcon, CircleNotchIcon, WrenchIcon, CaretRightIcon, CaretDownIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { formatRelativeDate } from "../utils/dates.js";
import { parseRepoName } from "../utils/repo-label.js";
import { Button } from "./ui/button.js";
import { WithTooltip } from "./ui/tooltip.js";
import { RepoSwitcher } from "./RepoSwitcher.js";
import { PrStateBadge } from "./PrLifecycleCard.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { usePrStore } from "../stores/pr-store.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";

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

  // eslint-disable-next-line no-restricted-syntax -- existing usage
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
interface SessionSidebarProps {
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  onResume: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onNewSessionForRepo: (repoUrl: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  // Repo actions
  repos: RepoInfo[];
  onAddRepo: () => void;
  onCreateNewRepo: () => void;
}

interface SessionItemProps {
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

  // Priority 4: CI pending — wait for results before flagging
  if (checks?.state === "pending") return null;

  // Priority 5: PR merged/closed — no action needed
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
        needsAttention ? "border-x-2 border-x-(--color-attention)" : "border-x-2 border-x-transparent"
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
            <WithTooltip label="Restore session">
            <Button
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); onRestore(session.id); }}
              disabled={disabled}
              className="p-1! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-success)"
              aria-label="Restore session"
            >
              <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} />
            </Button>
            </WithTooltip>
          )}
          {!isArchived && onArchive && (
            <WithTooltip label="Archive session">
            <Button
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); onArchive(session.id); }}
              disabled={disabled}
              className="p-1! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-warning)"
              aria-label="Archive session"
            >
              <PhArchiveIcon size={ICON_SIZE.SM} />
            </Button>
            </WithTooltip>
          )}
        </div>
    </div>
  );
}

/** A collapsible group of sessions for a single repo. */
function RepoGroup({
  repo,
  sessions,
  currentSessionId,
  isCollapsed,
  onToggleCollapse,
  onResume,
  onArchive,
  onNewSession,
  onViewAll,
}: {
  repo: RepoInfo;
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onResume: (id: string) => void;
  onArchive: (id: string) => void;
  onNewSession: () => void;
  onViewAll: () => void;
}) {
  const repoName = parseRepoName(repo.url);

  return (
    <div className="flex flex-col">
      {/* Repo header row */}
      <div className="flex items-center gap-1 px-3 py-1.5 sticky top-0 bg-(--color-bg-primary) z-10">
        <button
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left group"
          aria-label={isCollapsed ? `Expand ${repoName}` : `Collapse ${repoName}`}
        >
          {isCollapsed
            ? <CaretRightIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary) group-hover:text-(--color-text-secondary)" />
            : <CaretDownIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary) group-hover:text-(--color-text-secondary)" />
          }
          <GithubLogoIcon size={ICON_SIZE.XS} weight="fill" className="shrink-0 text-(--color-text-secondary)" />
          <span className="text-xs font-semibold text-(--color-text-secondary) truncate tracking-wide group-hover:text-(--color-text-primary) transition-colors">
            {repoName}
          </span>
          {repo.status === "cloning" && (
            <span className="shrink-0 text-[9px] text-(--color-warning) animate-pulse">cloning</span>
          )}
        </button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onViewAll}
          className="text-[10px] text-(--color-text-tertiary) hover:text-(--color-text-primary) px-1 py-0.5 shrink-0"
        >
          View All
        </Button>
      </div>

      {/* Session list — hidden when collapsed */}
      {!isCollapsed && (
        <div className="flex flex-col gap-0.5">
          {/* Inline new session button */}
          <button
            onClick={onNewSession}
            disabled={repo.status === "cloning"}
            className="flex items-center gap-1.5 px-3 py-1 mx-1 text-[11px] text-(--color-text-tertiary) hover:text-(--color-success) transition-colors rounded hover:bg-(--color-bg-hover) disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <PlusIcon size={ICON_SIZE.XS} />
            New Session
          </button>
          {sessions.length === 0 ? (
            <p className="text-[10px] text-(--color-text-tertiary) px-3 py-1 text-center">No sessions</p>
          ) : (
            sessions.map((s) => (
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
      )}
    </div>
  );
}

export function SessionSidebar({
  sessions,
  currentSessionId,
  onResume,
  onArchive,
  onNewSessionForRepo,
  collapsed,
  onToggleCollapse,
  repos,
  onAddRepo,
  onCreateNewRepo,
}: SessionSidebarProps) {
  const { width, isDragging, onMouseDown } = useSidebarResize();

  const collapsedRepos = useRepoStore((s) => s.collapsedRepos);
  const toggleRepoCollapsed = useRepoStore((s) => s.toggleRepoCollapsed);

  // Group sessions by repo URL with a STABLE sort within each group.
  // Sessions are intentionally NOT sorted by `lastUsedAt`: that field updates on every
  // agent event during a turn, which would reshuffle the list under the user's cursor and
  // cause mis-clicks. Instead:
  //   - Non-merged sessions sort by `createdAt` desc (newest first) — never changes.
  //   - Merged sessions sink to the bottom, sorted by `mergedAt` desc (most recently merged first).
  // Repos are sorted by `addedAt` desc — also stable — so the whole layout stays put.
  const repoGroups = useMemo(() => {
    const grouped = new Map<string, SessionInfo[]>();

    // Initialize groups for all known repos
    for (const repo of repos) {
      grouped.set(repo.url, []);
    }

    // Distribute sessions into groups
    for (const s of sessions) {
      const key = s.remoteUrl ?? "";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(s);
    }

    // Sort sessions within each group: non-merged first (by createdAt desc), then merged
    // (by mergedAt desc, falling back to createdAt desc if mergedAt is missing).
    for (const [, group] of grouped) {
      group.sort((a, b) => {
        const aMerged = a.mergedAt ? 1 : 0;
        const bMerged = b.mergedAt ? 1 : 0;
        if (aMerged !== bMerged) return aMerged - bMerged;
        if (aMerged === 1) {
          const aKey = a.mergedAt ?? a.createdAt ?? "";
          const bKey = b.mergedAt ?? b.createdAt ?? "";
          return bKey.localeCompare(aKey);
        }
        return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      });
    }

    // Build sorted repo list — stable order, by repo addedAt desc.
    const repoOrder = repos.slice().sort((a, b) => {
      return (b.addedAt ?? "").localeCompare(a.addedAt ?? "");
    });

    return repoOrder.map((repo) => ({
      repo,
      sessions: grouped.get(repo.url) ?? [],
    }));
  }, [repos, sessions]);

  const handleViewAll = useCallback((repoUrl: string) => {
    // Open AllSessionsDialog (it will default to filtering by the current repo)
    // We set activeRepoUrl so the dialog pre-selects this repo
    useRepoStore.getState().setActiveRepoUrl(repoUrl);
    useSessionStore.getState().setAllSessionsDialogOpen(true);
  }, []);

  // Single repo mode: check if we only have one repo
  const isSingleRepo = repos.length === 1;

  if (collapsed) {
    return (
      <div className="flex flex-col w-10 h-full shrink-0 bg-(--color-bg-primary) border-r border-(--color-border-primary) items-center py-2 gap-2">
        <WithTooltip label="Expand sidebar" side="right">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          className="p-0! w-6 h-6"
          aria-label="Expand sidebar"
        >
          <SidebarSimpleIcon size={ICON_SIZE.SM} />
        </Button>
        </WithTooltip>
        <RepoSwitcher repos={repos} activeRepoUrl={useRepoStore.getState().activeRepoUrl} onSelectRepo={(url) => useRepoStore.getState().setActiveRepoUrl(url)} onAddRepo={onAddRepo} onCreateNew={onCreateNewRepo}>
        <Button
          variant="ghost"
          size="sm"
          className="p-0! w-6 h-6 text-(--color-text-secondary) hover:text-(--color-text-primary)"
          aria-label="Repository"
        >
          <GithubLogoIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0" />
        </Button>
        </RepoSwitcher>
        <div className="flex-1" />
        <WithTooltip label="New Session" side="right">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { const url = useRepoStore.getState().activeRepoUrl ?? repos[0]?.url; if (url) onNewSessionForRepo(url); }}
          disabled={repos.length === 0}
          className="p-0! w-6 h-6 text-(--color-success) hover:text-(--color-success)"
          aria-label="New Session"
        >
          <PlusIcon size={ICON_SIZE.SM} />
        </Button>
        </WithTooltip>
      </div>
    );
  }

  return (
    <div className="flex h-full shrink-0 min-h-0">
    <div className="flex flex-col h-full bg-(--color-bg-primary) border-r border-(--color-border-primary) min-h-0" style={{ width }}>
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-(--color-border-primary) shrink-0">
        <WithTooltip label="Collapse sidebar">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          className="p-0! w-6 h-6 text-(--color-text-tertiary)"
          aria-label="Collapse sidebar"
        >
          <SidebarSimpleIcon size={ICON_SIZE.SM} />
        </Button>
        </WithTooltip>
        <span className="flex-1" />
        <WithTooltip label="Add Repository">
        <Button
          variant="ghost"
          size="sm"
          onClick={onAddRepo}
          className="p-0! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-text-primary)"
          aria-label="Add Repository"
        >
          <PlusIcon size={ICON_SIZE.SM} />
        </Button>
        </WithTooltip>
      </div>

      {/* Scrollable grouped repo sections */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-2 py-1">
        {repos.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-8">
            <p className="text-xs text-(--color-text-tertiary) text-center">No repositories yet.</p>
            <Button variant="primary" onClick={onAddRepo} className="gap-1.5">
              <PlusIcon size={14} />
              Add Repository
            </Button>
          </div>
        ) : (
          repoGroups.map(({ repo, sessions: repoSessions }) => (
            <RepoGroup
              key={repo.url}
              repo={repo}
              sessions={repoSessions}
              currentSessionId={currentSessionId}
              isCollapsed={!isSingleRepo && collapsedRepos.has(repo.url)}
              onToggleCollapse={() => toggleRepoCollapsed(repo.url)}
              onResume={onResume}
              onArchive={onArchive}
              onNewSession={() => onNewSessionForRepo(repo.url)}
              onViewAll={() => handleViewAll(repo.url)}
            />
          ))
        )}
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
