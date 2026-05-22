// eslint-disable-next-line no-restricted-imports -- useEffect: document.body style during drag (DOM sync)
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ArchiveIcon as PhArchiveIcon, ArrowCounterClockwiseIcon, DotsThreeVerticalIcon, DotsSixVerticalIcon, GithubLogoIcon, ListBulletsIcon, PlusIcon, SidebarSimpleIcon, CheckCircleIcon, XCircleIcon, CircleNotchIcon, TrashIcon, WrenchIcon, SlidersHorizontalIcon, CaretRightIcon, CaretDownIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { formatRelativeDate } from "../utils/dates.js";
import { parseRepoName } from "../utils/repo-label.js";
import { Button } from "./ui/button.js";
import { WithTooltip } from "./ui/tooltip.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu.js";
import { RepoSwitcher } from "./RepoSwitcher.js";
import { PrStateBadge } from "./PrLifecycleCard.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useUiStore } from "../stores/ui-store.js";
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

  // Disable text selection while dragging the sidebar handle.
  // Cleanup runs on isDragging→false AND on unmount, so a mid-drag unmount
  // can't leave userSelect: none stuck on <body> and block selection app-wide.
  // eslint-disable-next-line no-restricted-syntax -- DOM sync during drag
  useEffect(() => {
    if (!isDragging) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isDragging]);

  return { width, isDragging, onMouseDown };
}
interface SessionSidebarProps {
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  /** Repo URL whose "New session" row should render as selected (user is on /{slug}/new). */
  activeNewSessionRepoUrl?: string;
  onResume: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onNewSessionForRepo: (repoUrl: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  // Repo actions
  repos: RepoInfo[];
  onAddRepo: () => void;
  onCreateNewRepo: () => void;
  // Mobile drawer mode: full-width, no resize handle, no collapsed variant.
  // Top-bar collapse button is replaced with a close (X) button that calls onClose.
  mobile?: boolean;
  onClose?: () => void;
}

interface SessionItemProps {
  session: SessionInfo;
  isCurrent: boolean;
  onResume: (id: string) => void;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
  repoLabel?: string;
  disabled?: boolean;
  /**
   * docs/117 Phase 2 — when true, this session row is rendered indented to
   * indicate it was spawned by another session in the same group (the
   * parent appears immediately above). Visual-only; the click target and
   * archive controls are identical to a regular row.
   */
  indented?: boolean;
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

  // Priority 2: Merge conflicts. Only "conflicting" raises attention — "unknown"
  // is the transient post-push computation window and shouldn't flag the session.
  if (prState === "open" && mergeable === "conflicting") {
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

  // Priority 1: Auto-fix running (a specific form of agent activity)
  if (autoFix?.status === "running") {
    return <span className="shrink-0 text-(--color-autofix) flex" title="Auto-fix running"><WrenchIcon size={ICON_SIZE.XS} className="animate-spin" /></span>;
  }

  // Priority 2: Agent running — takes precedence over CI status; the agent
  // may already be addressing the failure, so don't surface a stale CI-failed
  // indicator while it's working.
  if (isAgentRunning) {
    return <span className="w-2 h-2 rounded-full bg-(--color-success) animate-pulse shrink-0" title="Agent running" />;
  }

  // Priority 3: CI failed (auto-fix not running and agent idle, both checked above)
  if (checks?.state === "failure") {
    return <span className="shrink-0 text-(--color-error) flex" title={`CI failed ${checks.failed} of ${checks.total}`}><XCircleIcon size={ICON_SIZE.XS} /></span>;
  }

  // Priority 4: CI pending
  if (checks?.state === "pending") {
    return <span className="shrink-0 text-(--color-warning) flex" title={`CI running ${checks.passed}/${checks.total}`}><CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" /></span>;
  }

  // Priority 5: CI passed
  if (checks?.state === "success") {
    return <span className="shrink-0 text-(--color-success) flex" title={`CI passed ${checks.total}/${checks.total}`}><CheckCircleIcon size={ICON_SIZE.XS} /></span>;
  }

  // Priority 6: idle / no data
  return null;
}

export function SessionItem({ session, isCurrent, onResume, onArchive, onRestore, repoLabel, disabled, indented }: SessionItemProps) {
  const isArchived = session.archived === true;

  const attentionReason = useAttentionInfo(session.id);
  const needsAttention = attentionReason !== null && !isArchived;

  return (
    <div
      data-testid={indented ? "session-item-indented" : "session-item"}
      className={`group flex items-start gap-1.5 px-2 py-1.5 text-xs transition-colors rounded mx-1 ${
        indented ? "ml-5" : ""
      } ${
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

/** Drop indicator: "before" puts the dragged repo above this one, "after" below. */
type DropPosition = "before" | "after";

/** A collapsible group of sessions for a single repo. */
function RepoGroup({
  repo,
  sessions,
  currentSessionId,
  isNewSessionSelected,
  isCollapsed,
  onToggleCollapse,
  onResume,
  onArchive,
  onNewSession,
  onViewAll,
  onProjectSettings,
  onRemoveRepo,
  // Drag-and-drop reordering
  draggable,
  isBeingDragged,
  dropIndicator,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  repo: RepoInfo;
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  isNewSessionSelected: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onResume: (id: string) => void;
  onArchive: (id: string) => void;
  onNewSession: () => void;
  onViewAll: () => void;
  onProjectSettings: () => void;
  onRemoveRepo: () => void;
  // Drag-and-drop reordering — only enabled when there's more than one repo.
  draggable: boolean;
  /** True when this group is the source of the active drag. */
  isBeingDragged: boolean;
  /** Where to render the drop indicator line; null when this group is not a target. */
  dropIndicator: DropPosition | null;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}) {
  const repoName = parseRepoName(repo.url);
  // "Click again to confirm" idiom (see Settings.tsx). Kept local to the menu so
  // it resets whenever the dropdown closes — preventing a stale "confirming" state
  // from carrying over to the next time the user opens the menu.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  return (
    <div
      className={`flex flex-col relative ${isBeingDragged ? "opacity-40" : ""}`}
      onDragOver={draggable ? onDragOver : undefined}
      onDragLeave={draggable ? onDragLeave : undefined}
      onDrop={draggable ? onDrop : undefined}
    >
      {/* Drop indicator: a horizontal line at the top or bottom of the group.
          Rendered absolutely so it doesn't shift the layout, which would cause
          the dragenter target to jump out from under the cursor mid-drag. */}
      {dropIndicator === "before" && (
        <div className="absolute left-2 right-2 -top-px h-0.5 bg-(--color-success) z-20 rounded-full pointer-events-none" />
      )}
      {dropIndicator === "after" && (
        <div className="absolute left-2 right-2 -bottom-px h-0.5 bg-(--color-success) z-20 rounded-full pointer-events-none" />
      )}
      {/* Repo header row */}
      <div
        className="flex items-center gap-1 px-3 py-1.5 sticky top-0 bg-(--color-bg-primary) z-10 group/header"
        draggable={draggable}
        onDragStart={draggable ? onDragStart : undefined}
        onDragEnd={draggable ? onDragEnd : undefined}
      >
        {/* Drag handle — visible on header hover when reordering is enabled.
            Kept outside the collapse-toggle <button> so grabbing it doesn't
            also fire onToggleCollapse on click. The actual drag event lives on
            the parent header div, so this is purely a visual affordance. */}
        {draggable && (
          <span
            className="shrink-0 text-(--color-text-tertiary) opacity-0 group-hover/header:opacity-100 transition-opacity cursor-grab active:cursor-grabbing -ml-1"
            aria-hidden
            title="Drag to reorder"
          >
            <DotsSixVerticalIcon size={ICON_SIZE.SM} />
          </span>
        )}
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
        <DropdownMenu
          onOpenChange={(open) => {
            // Reset the destructive-confirm state every time the menu closes,
            // so a partial confirmation never carries to the next open.
            if (!open) setConfirmingRemove(false);
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="p-0! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-text-primary) shrink-0"
              aria-label={`${repoName} repository menu`}
            >
              <DotsThreeVerticalIcon size={ICON_SIZE.SM} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onViewAll}>
              <ListBulletsIcon size={ICON_SIZE.XS} className="shrink-0" />
              View All Sessions
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onProjectSettings}>
              <SlidersHorizontalIcon size={ICON_SIZE.XS} className="shrink-0" />
              Project Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                if (!confirmingRemove) {
                  // First click: keep the menu open and switch label to confirmation.
                  e.preventDefault();
                  setConfirmingRemove(true);
                  return;
                }
                // Second click: run the action; menu closes via default Radix behavior.
                onRemoveRepo();
              }}
              className="text-(--color-error) hover:text-(--color-error) focus:text-(--color-error)"
            >
              <TrashIcon size={ICON_SIZE.XS} className="shrink-0" />
              {confirmingRemove ? "Click again to confirm" : "Remove Repository"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Session list — hidden when collapsed */}
      {!isCollapsed && (
        <div className="flex flex-col gap-0.5 pb-2">
          {/* New session row — matches SessionItem shape so it can render as selected */}
          <button
            type="button"
            onClick={onNewSession}
            disabled={repo.status === "cloning"}
            className={`group flex items-center gap-1.5 px-2 py-1.5 text-xs transition-colors rounded mx-1 border-x-2 border-x-transparent disabled:opacity-50 disabled:cursor-not-allowed ${
              isNewSessionSelected
                ? "bg-(--color-bg-secondary) text-(--color-text-primary)"
                : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
            }`}
            aria-current={isNewSessionSelected ? "page" : undefined}
          >
            <span className="w-5 h-5 flex items-center justify-center shrink-0 opacity-70">
              <PlusIcon size={ICON_SIZE.MD} weight="bold" />
            </span>
            <span className="truncate leading-snug">New session</span>
          </button>
          {sessions.length === 0 ? (
            <p className="text-[10px] text-(--color-text-tertiary) px-3 py-1 text-center">No sessions</p>
          ) : (
            // docs/117 Phase 2 — render agent-spawned children indented under
            // their parent. We bucket children by `parentSessionId`, iterate
            // top-level sessions in the existing stable order, then immediately
            // follow each parent with its children (also in stable order). A
            // child whose parent isn't visible in this repo group (archived
            // out of the list, cross-repo, etc.) is rendered at top level as
            // a fallback so it never silently disappears from the sidebar.
            (() => {
              const childrenByParent = new Map<string, SessionInfo[]>();
              const orphanedChildren = new Set<string>();
              for (const s of sessions) {
                if (!s.parentSessionId) continue;
                const parentInGroup = sessions.some((p) => p.id === s.parentSessionId);
                if (!parentInGroup) {
                  orphanedChildren.add(s.id);
                  continue;
                }
                const list = childrenByParent.get(s.parentSessionId) ?? [];
                list.push(s);
                childrenByParent.set(s.parentSessionId, list);
              }
              const rendered: React.ReactElement[] = [];
              for (const s of sessions) {
                // Skip children that we'll render beneath their parent below.
                if (s.parentSessionId && !orphanedChildren.has(s.id)) continue;
                rendered.push(
                  <SessionItem
                    key={s.id}
                    session={s}
                    isCurrent={s.id === currentSessionId}
                    onResume={onResume}
                    onArchive={onArchive}
                  />,
                );
                const children = childrenByParent.get(s.id);
                if (!children) continue;
                for (const child of children) {
                  rendered.push(
                    <SessionItem
                      key={child.id}
                      session={child}
                      isCurrent={child.id === currentSessionId}
                      onResume={onResume}
                      onArchive={onArchive}
                      indented
                    />,
                  );
                }
              }
              return rendered;
            })()
          )}
        </div>
      )}
    </div>
  );
}

export function SessionSidebar({
  sessions,
  currentSessionId,
  activeNewSessionRepoUrl,
  onResume,
  onArchive,
  onNewSessionForRepo,
  collapsed,
  onToggleCollapse,
  repos,
  onAddRepo,
  onCreateNewRepo,
  mobile = false,
  onClose,
}: SessionSidebarProps) {
  const { width, isDragging, onMouseDown } = useSidebarResize();

  const collapsedRepos = useRepoStore((s) => s.collapsedRepos);
  const toggleRepoCollapsed = useRepoStore((s) => s.toggleRepoCollapsed);
  const reorderRepos = useRepoStore((s) => s.reorderRepos);

  // Drag-and-drop reorder state. Lives at the sidebar level so all groups
  // share a single drag context — only one group can be "over" at a time.
  const [draggedRepoUrl, setDraggedRepoUrl] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ url: string; position: "before" | "after" } | null>(null);

  // Group sessions by repo URL with a STABLE sort within each group.
  // Sessions are intentionally NOT sorted by `lastUsedAt`: that field updates on every
  // agent event during a turn, which would reshuffle the list under the user's cursor and
  // cause mis-clicks. Instead:
  //   - Non-merged sessions sort by `createdAt` desc (newest first) — never changes.
  //   - Merged sessions sink to the bottom, sorted by `mergedAt` desc (most recently merged first).
  // Repo order is whatever the server returns — `display_order` first, then
  // `last_used_at` desc for repos the user has never reordered. We deliberately
  // do NOT re-sort here: it would override the user's drag-and-drop choice and
  // also break the optimistic UI update (which mutates the list order before
  // the server response).
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

    // Preserve the server-provided order — see comment block above.
    return repos.map((repo) => ({
      repo,
      sessions: grouped.get(repo.url) ?? [],
    }));
  }, [repos, sessions]);

  const handleViewAll = useCallback((repoUrl: string) => {
    // Open AllSessionsDialog (it will default to filtering by the current repo)
    // We set activeRepoUrl so the dialog pre-selects this repo
    useRepoStore.getState().setActiveRepoUrl(repoUrl);
    useSessionStore.getState().setAllSessionsDialogOpen(true);
    // Mobile drawer: close it so the dialog isn't stacked on top
    if (mobile) onClose?.();
  }, [mobile, onClose]);

  const handleProjectSettings = useCallback((repoUrl: string) => {
    // Per-repo project settings (deployments, secrets) live in their own dialog,
    // separate from the workspace-wide Settings. Scoped to the clicked repo.
    useUiStore.getState().setProjectSettingsRepoUrl(repoUrl);
    if (mobile) onClose?.();
  }, [mobile, onClose]);

  const handleRemoveRepo = useCallback((repoUrl: string) => {
    // Backend semantics (services/repos.ts + docs/059): the repo entry and its
    // warm session are removed; existing sessions are preserved on disk but become
    // invisible in the sidebar until the repo is re-added. The "Click again to
    // confirm" idiom in the menu item guards against accidental clicks; we don't
    // need a separate dialog.
    void useRepoStore.getState().removeRepo(repoUrl);
  }, []);

  // Single repo mode: check if we only have one repo
  const isSingleRepo = repos.length === 1;

  // Reordering is only meaningful when there's more than one repo to swap.
  const reorderEnabled = repos.length > 1;

  const handleDragStart = useCallback(
    (repoUrl: string) => (e: React.DragEvent) => {
      // dataTransfer payload — we read it back on drop. Using a custom MIME
      // type so a stray drag of plain text from the page can't accidentally
      // look like a repo reorder.
      e.dataTransfer.setData("application/x-shipit-repo", repoUrl);
      e.dataTransfer.effectAllowed = "move";
      setDraggedRepoUrl(repoUrl);
    },
    [],
  );

  const handleDragOver = useCallback(
    (repoUrl: string) => (e: React.DragEvent) => {
      // Bail out early when not in a repo-reorder drag — lets file drops etc.
      // bubble up naturally without preventDefault muting them.
      if (!draggedRepoUrl) return;
      // Required so the drop actually fires; without preventDefault on
      // dragover, the browser treats the element as a non-target and skips
      // onDrop entirely.
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (repoUrl === draggedRepoUrl) {
        // Drop on self is a no-op — don't render an indicator either.
        setDropTarget(null);
        return;
      }
      // Top half → "before", bottom half → "after". Uses the bounding rect of
      // the currentTarget (the wrapper div on the group, not the header), so
      // the indicator switches correctly when the user moves between the
      // upper and lower halves of an expanded group's session list too.
      const rect = e.currentTarget.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      const position: "before" | "after" = e.clientY < midpoint ? "before" : "after";
      setDropTarget((prev) =>
        prev?.url === repoUrl && prev.position === position ? prev : { url: repoUrl, position },
      );
    },
    [draggedRepoUrl],
  );

  const handleDragLeave = useCallback(
    (repoUrl: string) => (e: React.DragEvent) => {
      // Only clear when leaving the group entirely. Without the relatedTarget
      // check, hovering over a child element fires dragleave and flickers the
      // indicator off and on as the cursor moves.
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return;
      setDropTarget((prev) => (prev?.url === repoUrl ? null : prev));
    },
    [],
  );

  const handleDrop = useCallback(
    (targetUrl: string) => (e: React.DragEvent) => {
      e.preventDefault();
      const sourceUrl = e.dataTransfer.getData("application/x-shipit-repo") || draggedRepoUrl;
      const position = dropTarget?.position;
      setDraggedRepoUrl(null);
      setDropTarget(null);
      if (!sourceUrl || sourceUrl === targetUrl || !position) return;

      // Compute the new url order: remove the source from its current slot,
      // then insert it relative to the target.
      const current = repos.map((r) => r.url);
      const sourceIdx = current.indexOf(sourceUrl);
      if (sourceIdx === -1) return;
      current.splice(sourceIdx, 1);
      let targetIdx = current.indexOf(targetUrl);
      if (targetIdx === -1) return;
      if (position === "after") targetIdx += 1;
      current.splice(targetIdx, 0, sourceUrl);

      // No-op when the order didn't change (drop landed back in place).
      const prevOrder = repos.map((r) => r.url).join("\n");
      const nextOrder = current.join("\n");
      if (prevOrder === nextOrder) return;

      void reorderRepos(current);
    },
    [draggedRepoUrl, dropTarget, repos, reorderRepos],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedRepoUrl(null);
    setDropTarget(null);
  }, []);

  if (collapsed && !mobile) {
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
    <div
      className={`flex flex-col h-full bg-(--color-bg-primary) ${mobile ? "" : "border-r border-(--color-border-primary)"} min-h-0`}
      style={mobile ? { width: "100%" } : { width }}
    >
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-(--color-border-primary) shrink-0">
        {mobile ? (
          <WithTooltip label="Close">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="p-0! w-6 h-6 text-(--color-text-tertiary)"
            aria-label="Close sidebar"
          >
            <XIcon size={ICON_SIZE.SM} />
          </Button>
          </WithTooltip>
        ) : (
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
        )}
        <span className="flex-1" />
        <RepoSwitcher
          repos={repos}
          activeRepoUrl={useRepoStore.getState().activeRepoUrl}
          onSelectRepo={(url) => useRepoStore.getState().setActiveRepoUrl(url)}
          onAddRepo={onAddRepo}
          onCreateNew={onCreateNewRepo}
        >
          <Button
            variant="ghost"
            size="sm"
            className="p-0! w-6 h-6 text-(--color-text-tertiary) hover:text-(--color-text-primary)"
            aria-label="Repository"
          >
            <GithubLogoIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0" />
          </Button>
        </RepoSwitcher>
      </div>

      {/* Scrollable grouped repo sections */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col py-1">
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
              isNewSessionSelected={activeNewSessionRepoUrl === repo.url}
              isCollapsed={!isSingleRepo && collapsedRepos.has(repo.url)}
              onToggleCollapse={() => toggleRepoCollapsed(repo.url)}
              onResume={onResume}
              onArchive={onArchive}
              onNewSession={() => onNewSessionForRepo(repo.url)}
              onViewAll={() => handleViewAll(repo.url)}
              onProjectSettings={() => handleProjectSettings(repo.url)}
              onRemoveRepo={() => handleRemoveRepo(repo.url)}
              draggable={reorderEnabled}
              isBeingDragged={draggedRepoUrl === repo.url}
              dropIndicator={dropTarget?.url === repo.url ? dropTarget.position : null}
              onDragStart={handleDragStart(repo.url)}
              onDragOver={handleDragOver(repo.url)}
              onDragLeave={handleDragLeave(repo.url)}
              onDrop={handleDrop(repo.url)}
              onDragEnd={handleDragEnd}
            />
          ))
        )}
      </div>
    </div>
    {/* Resize handle — desktop only; overlaid on top of the border */}
    {!mobile && (
      <div
        onMouseDown={onMouseDown}
        className={`resize-handle shrink-0 -ml-2 ${isDragging ? "resize-handle--active" : ""}`}
      />
    )}
    </div>
  );
}
