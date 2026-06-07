// eslint-disable-next-line no-restricted-imports -- useEffect: document.body style during drag (DOM sync)
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ArchiveIcon as PhArchiveIcon, ArrowCounterClockwiseIcon, CloudArrowDownIcon, DotsSixVerticalIcon, GithubLogoIcon, GitMergeIcon, HardDrivesIcon, ListBulletsIcon, PencilSimpleIcon, PlusIcon, SidebarSimpleIcon, CheckCircleIcon, XCircleIcon, CircleNotchIcon, TrashIcon, WrenchIcon, SlidersHorizontalIcon, CaretRightIcon, CaretDownIcon } from "@phosphor-icons/react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { AUTO_MERGE_ICON_CLASS, ICON_SIZE } from "../design-tokens.js";
import { formatRelativeDate } from "../utils/dates.js";
import { parseRepoName } from "../utils/repo-label.js";
import { Button } from "./ui/button.js";
import { WithTooltip } from "./ui/tooltip.js";
import { DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu.js";
import { OverflowMenu } from "./ui/overflow-menu.js";
import { RepoSwitcher } from "./RepoSwitcher.js";
import { PrStateBadge } from "./PrLifecycleCard.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useAttentionInfo } from "../hooks/useAttentionInfo.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";
import { parseTimestampMs } from "../../server/shared/utils.js";

/**
 * docs/161 — client mirror of the server's `reopenedAfterMerge` predicate
 * (`sessions.ts`). True when a merged session has had real *follow-up work*
 * since its merge — the user returned and advanced the branch toward a new PR.
 * Keys on `lastBranchCommitAt` (stamped only when a turn moves HEAD), NOT on
 * `lastUsedAt`: a turn that makes no commit (answering a question, or spawning a
 * child session to do the work) bumps `lastUsedAt` but is not a reopen. Keying
 * on branch advance keeps such a session — and its merged children, which are
 * grouped by the parent's status — correctly under "Recently merged".
 *
 * `mergedAt` and `lastBranchCommitAt` are both `datetime('now')` (UTC, no
 * timezone suffix) but the predicate may also see ISO timestamps (`…Z`). This
 * runs in the BROWSER, so a plain `Date.parse` would read a suffix-less value as
 * *local* time and mis-order the two in a non-UTC timezone, falsely flagging a
 * reopen. `parseTimestampMs` normalizes both to UTC. (CI runs in UTC, so the
 * test suite never reproduced that.)
 */
function reopenedAfterMerge(s: SessionInfo): boolean {
  if (!s.mergedAt || !s.lastBranchCommitAt) return false;
  const merged = parseTimestampMs(s.mergedAt);
  const committed = parseTimestampMs(s.lastBranchCommitAt);
  if (Number.isNaN(merged) || Number.isNaN(committed)) return false;
  return committed > merged;
}

/**
 * docs/161 — a session that belongs in the sidebar's demoted "Recently merged"
 * group: merged and not reopened since. A reopened merged session rejoins the
 * Active group automatically.
 */
function isRecentlyMerged(s: SessionInfo): boolean {
  return !!s.mergedAt && !reopenedAfterMerge(s);
}

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
  // Mobile drawer mode: full-width, no resize handle, no collapsed variant,
  // and no top bar (toggled open/closed via the bottom tab bar's Sessions button).
  mobile?: boolean;
  // Called to dismiss the mobile drawer — e.g. after selecting a session.
  onClose?: () => void;
}

interface SessionItemProps {
  session: SessionInfo;
  isCurrent: boolean;
  onResume: (id: string) => void;
  onSelectCurrent?: () => void;
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
  /**
   * Number of agent-spawned children attached to this session. When > 0,
   * the row renders a caret toggle on the left so the user can collapse the
   * brood — matches the existing repo-header caret pattern.
   */
  childCount?: number;
  isChildrenCollapsed?: boolean;
  onToggleChildren?: () => void;
  /**
   * docs/156 — true when the device is a touch screen. The session row's
   * overflow menu trigger is always visible on touch (no hover affordance);
   * on desktop it hover-reveals on inactive rows.
   */
  isTouch?: boolean;
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

/**
 * Auto-merge indicator, right-aligned on the session row's meta line. Auto-merge
 * is a session-level preference that can be armed before any PR exists, so it's
 * read from the persistent per-session map (falling back to the open-phase card
 * value) and rendered independently of CI/PR state. Neutral secondary color: it's
 * an informational "armed" attribute, not a status, so it must not collide with
 * the colored CI glyphs (accent/success collide with status colors in warm/light
 * themes).
 */
function AutoMergeBadge({ sessionId }: { sessionId: string }) {
  const autoMerge = usePrStore((s) => s.autoMergeBySession[sessionId] ?? s.cardBySession[sessionId]?.autoMerge);
  if (!(autoMerge?.enabled ?? false)) return null;
  return (
    <span className={`shrink-0 flex ml-auto ${AUTO_MERGE_ICON_CLASS}`} title="Auto-merge enabled">
      <GitMergeIcon size={ICON_SIZE.XS} weight="bold" />
    </span>
  );
}

/**
 * docs/161 — surfaces a session's *disk tier* when it isn't fully `hot`, so the
 * user knows selecting it triggers a restore. Listing is orthogonal to disk: an
 * `evicted` session can still be in the sidebar (it re-clones from cache on
 * select) and a `light` one keeps its checkout but reinstalls deps on open. The
 * badge is suppressed for user-archived rows, where the archive icon already
 * conveys the (also-evicted) state.
 */
function DiskTierBadge({ session }: { session: SessionInfo }) {
  if (session.diskTier === "light") {
    return (
      <span className="shrink-0 flex text-(--color-text-tertiary)" title="Dependencies cleared to save disk — reinstalled when you open it">
        <HardDrivesIcon size={ICON_SIZE.XS} />
      </span>
    );
  }
  if (session.diskTier === "evicted") {
    return (
      <span className="shrink-0 flex text-(--color-text-tertiary)" title="Workspace stored to save disk — restored from the cache when you open it">
        <CloudArrowDownIcon size={ICON_SIZE.XS} />
      </span>
    );
  }
  return null;
}

export function SessionItem({ session, isCurrent, onResume, onSelectCurrent, onArchive, onRestore, repoLabel, disabled, indented, childCount, isChildrenCollapsed, onToggleChildren, isTouch }: SessionItemProps) {
  const isArchived = session.archived === true;

  const attentionReason = useAttentionInfo(session.id);
  const needsAttention = attentionReason !== null && !isArchived;
  const hasChildren = (childCount ?? 0) > 0 && !!onToggleChildren;

  const [menuOpen, setMenuOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editResolvedRef = useRef(false);

  const startEditing = useCallback(() => {
    setEditingTitle(session.title);
    editResolvedRef.current = false;
    setIsEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [session.title]);

  const submitRename = useCallback(() => {
    if (editResolvedRef.current) return;
    editResolvedRef.current = true;
    const trimmed = editingTitle.trim();
    if (trimmed && trimmed !== session.title) {
      void useSessionStore.getState().renameSession(session.id, trimmed);
    }
    setIsEditing(false);
    setEditingTitle("");
  }, [editingTitle, session.title, session.id]);

  const cancelEditing = useCallback(() => {
    editResolvedRef.current = true;
    setIsEditing(false);
    setEditingTitle("");
  }, []);

  // docs/128 — spin up a privileged ops session pre-loaded to investigate THIS
  // session. The store seeds the new session's composer with the target id +
  // a read-only first step, so the operator never copy-pastes the session id
  // into a blank ops session. On success we navigate straight into it.
  const handleInvestigateInOps = useCallback(async () => {
    const newId = await useSessionStore.getState().createOpsSession(session.id);
    if (newId) {
      onResume(newId);
    } else {
      useUiStore.getState().setToast({ message: "Failed to create ops session" });
    }
  }, [session.id, onResume]);

  // The overflow trigger is always visible on the active row, on touch
  // devices, and while the menu itself is open. On inactive desktop rows it
  // hover-reveals so it doesn't add visual noise to the long sidebar list.
  const overflowAlwaysVisible = isCurrent || menuOpen || Boolean(isTouch);

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
      {hasChildren && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleChildren?.(); }}
          className="shrink-0 -ml-1.5 w-4 h-4 mt-px flex items-center justify-center text-(--color-text-tertiary) hover:text-(--color-text-primary) rounded"
          aria-label={isChildrenCollapsed ? `Show ${childCount} spawned session${childCount === 1 ? "" : "s"}` : `Hide ${childCount} spawned session${childCount === 1 ? "" : "s"}`}
          title={isChildrenCollapsed ? `Show ${childCount} spawned` : `Hide ${childCount} spawned`}
        >
          {isChildrenCollapsed
            ? <CaretRightIcon size={ICON_SIZE.XS} />
            : <CaretDownIcon size={ICON_SIZE.XS} />
          }
        </button>
      )}
      <PrStateBadge sessionId={session.id} />

      {isEditing ? (
        <form
          onSubmit={(e) => { e.preventDefault(); submitRename(); }}
          className="flex-1 min-w-0"
        >
          <input
            ref={inputRef}
            type="text"
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") cancelEditing(); }}
            onBlur={submitRename}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-(--color-bg-tertiary) text-(--color-text-primary) text-xs px-1.5 py-0.5 rounded border border-(--color-border-secondary) focus:border-(--color-border-focus) focus:outline-none"
            maxLength={120}
            aria-label="Session name"
          />
        </form>
      ) : (
        <button
          onClick={() => {
            if (isCurrent) {
              onSelectCurrent?.();
              return;
            }
            onResume(session.id);
          }}
          disabled={disabled}
          className="flex-1 min-w-0 text-left"
        >
          <p className="truncate leading-snug">{session.title}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <SessionStatusDot sessionId={session.id} />
            {session.kind === "ops" && (
              <span className="text-[9px] font-semibold uppercase tracking-wide text-(--color-text-tertiary) border border-(--color-border-secondary) rounded px-1 leading-tight shrink-0">
                ops
              </span>
            )}
            {repoLabel && (
              <span className="text-[10px] text-(--color-text-tertiary) truncate">{repoLabel}</span>
            )}
            {isArchived && <PhArchiveIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary) shrink-0" />}
            {!isArchived && <DiskTierBadge session={session} />}
            <span className="text-(--color-text-tertiary) text-[10px]">{formatRelativeDate(session.lastUsedAt)}</span>
            <AutoMergeBadge sessionId={session.id} />
          </div>
        </button>
      )}

      {!isEditing && (
        <div
          className={`shrink-0 flex items-center gap-0.5 transition-opacity ${
            overflowAlwaysVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <OverflowMenu
            label="Session actions"
            triggerClassName="h-6 w-6"
            onOpenChange={setMenuOpen}
          >
            {!isArchived && (
              <>
                <DropdownMenuItem onSelect={startEditing} disabled={disabled}>
                  <PencilSimpleIcon size={ICON_SIZE.SM} />
                  Rename
                </DropdownMenuItem>
                {session.kind !== "ops" && (
                  <DropdownMenuItem onSelect={() => void handleInvestigateInOps()} disabled={disabled}>
                    <WrenchIcon size={ICON_SIZE.SM} />
                    Investigate in Ops session
                  </DropdownMenuItem>
                )}
                {onArchive && (
                  <DropdownMenuItem onSelect={() => onArchive(session.id)} disabled={disabled}>
                    <PhArchiveIcon size={ICON_SIZE.SM} />
                    Archive
                  </DropdownMenuItem>
                )}
              </>
            )}
            {isArchived && onRestore && (
              <DropdownMenuItem onSelect={() => onRestore(session.id)} disabled={disabled}>
                <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} />
                Restore
              </DropdownMenuItem>
            )}
          </OverflowMenu>
        </div>
      )}
    </div>
  );
}

/**
 * docs/128 — pinned group for privileged ops/host-debugging sessions. Keyed off
 * the server-authoritative `kind: "ops"` field, separate from repo and orphan
 * groups, with a Wrench icon so it reads as "the host tools" rather than a repo.
 */
function OpsSessionGroup({
  sessions,
  currentSessionId,
  isCollapsed,
  onToggleCollapse,
  onResume,
  onSelectCurrent,
  onArchive,
  isTouch,
}: {
  sessions: SessionInfo[];
  currentSessionId?: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onResume: (sessionId: string) => void;
  onSelectCurrent?: () => void;
  onArchive: (sessionId: string) => void;
  isTouch: boolean;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 pl-3.5 pr-3 py-1.5 sticky top-0 bg-(--color-bg-primary) z-10">
        <button
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left group"
          aria-label={isCollapsed ? "Expand Host / Ops" : "Collapse Host / Ops"}
        >
          <span className="w-5 h-5 flex items-center justify-center shrink-0 text-(--color-text-tertiary) group-hover:text-(--color-text-secondary)">
            {isCollapsed
              ? <CaretRightIcon size={ICON_SIZE.XS} />
              : <CaretDownIcon size={ICON_SIZE.XS} />
            }
          </span>
          <WrenchIcon size={ICON_SIZE.XS} weight="fill" className="shrink-0 text-(--color-text-secondary)" />
          <span className="text-xs font-semibold text-(--color-text-secondary) truncate tracking-wide group-hover:text-(--color-text-primary) transition-colors">
            Host / Ops
          </span>
        </button>
      </div>
      {!isCollapsed && (
        <div className="flex flex-col gap-0.5">
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isCurrent={session.id === currentSessionId}
              onResume={onResume}
              onSelectCurrent={onSelectCurrent}
              onArchive={onArchive}
              isTouch={isTouch}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Drop indicator: "before" puts the dragged repo above this one, "after" below. */
type DropPosition = "before" | "after";

function OrphanSessionGroup({
  label,
  sessions,
  currentSessionId,
  onResume,
  onSelectCurrent,
  onArchive,
  isTouch,
}: {
  label: string;
  sessions: SessionInfo[];
  currentSessionId?: string;
  onResume: (sessionId: string) => void;
  onSelectCurrent?: () => void;
  onArchive: (sessionId: string) => void;
  isTouch: boolean;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 pl-3.5 pr-3 py-1.5 sticky top-0 bg-(--color-bg-primary) z-10">
        <span className="w-5 h-5 shrink-0" />
        <span className="text-xs font-semibold text-(--color-text-secondary) truncate tracking-wide">
          {label}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {sessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            isCurrent={session.id === currentSessionId}
            onResume={onResume}
            onSelectCurrent={onSelectCurrent}
            onArchive={onArchive}
            isTouch={isTouch}
          />
        ))}
      </div>
    </div>
  );
}

/** A collapsible group of sessions for a single repo. */
function RepoGroup({
  repo,
  sessions,
  currentSessionId,
  isNewSessionSelected,
  isCollapsed,
  onToggleCollapse,
  collapsedParents,
  onToggleParentCollapsed,
  onResume,
  onSelectCurrent,
  onArchive,
  onNewSession,
  onViewAll,
  onProjectSettings,
  onRemoveRepo,
  isTouch,
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
  collapsedParents: Set<string>;
  onToggleParentCollapsed: (parentId: string) => void;
  onResume: (id: string) => void;
  onSelectCurrent?: () => void;
  onArchive: (id: string) => void;
  onNewSession: () => void;
  onViewAll: () => void;
  onProjectSettings: () => void;
  onRemoveRepo: () => void;
  isTouch: boolean;
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

  // FLIP animation for session rows reordering (PR merged sinks to bottom) or
  // exiting (archive). Library defaults — single duration/easing per parent,
  // respects prefers-reduced-motion automatically. See docs/148.
  const [listRef] = useAutoAnimate<HTMLDivElement>();

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
        className="flex items-center gap-1.5 pl-3.5 pr-3 py-1.5 sticky top-0 bg-(--color-bg-primary) z-10 group/header"
        draggable={draggable}
        onDragStart={draggable ? onDragStart : undefined}
        onDragEnd={draggable ? onDragEnd : undefined}
      >
        {/* Drag handle — visible on header hover when reordering is enabled.
            Kept outside the collapse-toggle <button> so grabbing it doesn't
            also fire onToggleCollapse on click. The actual drag event lives on
            the parent header div, so this is purely a visual affordance.
            Absolutely positioned so it overlays the left gutter without
            consuming layout width — that keeps the collapse caret aligned with
            the session rows below instead of being pushed right by the handle. */}
        {draggable && (
          <span
            className="absolute left-0.5 top-1/2 -translate-y-1/2 text-(--color-text-tertiary) opacity-0 group-hover/header:opacity-100 transition-opacity pointer-events-none"
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
          {/* Centering box matches the New-session "+" icon's w-5 box so the
              caret's visual center lines up with the plus below it. */}
          <span className="w-5 h-5 flex items-center justify-center shrink-0 text-(--color-text-tertiary) group-hover:text-(--color-text-secondary)">
            {isCollapsed
              ? <CaretRightIcon size={ICON_SIZE.XS} />
              : <CaretDownIcon size={ICON_SIZE.XS} />
            }
          </span>
          <GithubLogoIcon size={ICON_SIZE.XS} weight="fill" className="shrink-0 text-(--color-text-secondary)" />
          <span className="text-xs font-semibold text-(--color-text-secondary) truncate tracking-wide group-hover:text-(--color-text-primary) transition-colors">
            {repoName}
          </span>
          {repo.status === "cloning" && (
            <span className="shrink-0 text-[9px] text-(--color-warning) animate-pulse">cloning</span>
          )}
        </button>
        <OverflowMenu
          label={`${repoName} repository menu`}
          contentClassName="w-52"
          onOpenChange={(open) => {
            // Reset the destructive-confirm state every time the menu closes,
            // so a partial confirmation never carries to the next open.
            if (!open) setConfirmingRemove(false);
          }}
        >
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
        </OverflowMenu>
      </div>

      {/* Session list — hidden when collapsed */}
      {!isCollapsed && (
        <div ref={listRef} className="flex flex-col gap-0.5 pb-2">
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
          {sessions.length === 0 ? null : (
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
              // Render a top-level session followed by its (non-collapsed) children
              // into `target`. The brood stays together and is grouped by the
              // PARENT's status, so a parent's merge state — not each child's —
              // decides which group (Active vs Recently merged) the whole brood
              // lands in. This preserves the existing "children follow parent"
              // invariant.
              const pushTree = (s: SessionInfo, target: React.ReactElement[]) => {
                const children = childrenByParent.get(s.id);
                const childCount = children?.length ?? 0;
                const childrenCollapsed = collapsedParents.has(s.id);
                target.push(
                  <SessionItem
                    key={s.id}
                    session={s}
                    isCurrent={s.id === currentSessionId}
                    onResume={onResume}
                    onSelectCurrent={onSelectCurrent}
                    onArchive={onArchive}
                    isTouch={isTouch}
                    childCount={childCount}
                    isChildrenCollapsed={childrenCollapsed}
                    onToggleChildren={childCount > 0 ? () => onToggleParentCollapsed(s.id) : undefined}
                  />,
                );
                if (!children || childrenCollapsed) return;
                for (const child of children) {
                  target.push(
                    <SessionItem
                      key={child.id}
                      session={child}
                      isCurrent={child.id === currentSessionId}
                      onResume={onResume}
                      onSelectCurrent={onSelectCurrent}
                      onArchive={onArchive}
                      isTouch={isTouch}
                      indented
                    />,
                  );
                }
              };
              // docs/161 — split into Active and a demoted "Recently merged" group.
              // The session list is already sorted (active first, then merged by
              // mergedAt desc), so iterating in order keeps each group sorted.
              const active: React.ReactElement[] = [];
              const merged: React.ReactElement[] = [];
              for (const s of sessions) {
                // Skip children that we render beneath their parent.
                if (s.parentSessionId && !orphanedChildren.has(s.id)) continue;
                pushTree(s, isRecentlyMerged(s) ? merged : active);
              }
              return (
                <>
                  {active}
                  {merged.length > 0 && (
                    <div className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 mx-1" aria-hidden>
                      <GitMergeIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
                        Recently merged
                      </span>
                    </div>
                  )}
                  {merged}
                </>
              );
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
  // docs/156 — the row-level overflow menu hover-reveals on inactive desktop
  // rows but stays always-visible on touch devices, where there's no hover.
  const isTouch = useMediaQuery("(pointer: coarse)");

  const collapsedRepos = useRepoStore((s) => s.collapsedRepos);
  const toggleRepoCollapsed = useRepoStore((s) => s.toggleRepoCollapsed);
  const collapsedParents = useRepoStore((s) => s.collapsedParents);
  const toggleParentCollapsed = useRepoStore((s) => s.toggleParentCollapsed);
  const opsCollapsed = useRepoStore((s) => s.opsCollapsed);
  const toggleOpsCollapsed = useRepoStore((s) => s.toggleOpsCollapsed);
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
  //   - Archived sessions sink below everything (live > merged), within their parent's brood too.
  // Repo order is whatever the server returns — `display_order` first, then
  // `last_used_at` desc for repos the user has never reordered. We deliberately
  // do NOT re-sort here: it would override the user's drag-and-drop choice and
  // also break the optimistic UI update (which mutates the list order before
  // the server response).
  const repoGroups = useMemo(() => {
    const grouped = new Map<string, SessionInfo[]>();

    // docs/128 — ops sessions are a distinct kind, not repo-backed. Pull them
    // out before the repo/orphan distribution so they render in their own
    // pinned "Host / Ops" group instead of falling into "Other sessions".
    const opsSessions = sessions.filter((s) => s.kind === "ops");

    // Initialize groups for all known repos
    for (const repo of repos) {
      grouped.set(repo.url, []);
    }

    // Distribute sessions into groups
    for (const s of sessions) {
      if (s.kind === "ops") continue;
      const key = s.remoteUrl ?? "";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(s);
    }

    // Sort sessions within each group: archived sink to the very bottom, then
    // active first (by createdAt desc), then recently-merged (by mergedAt desc,
    // falling back to createdAt desc). docs/161 — "active" includes a *reopened*
    // merged session (worked in since the merge), so it bubbles back up out of
    // the merged tail; only `isRecentlyMerged` sinks.
    //
    // `archived` is the PRIMARY key so a hidden/archived session never sits
    // above a live one. Because children are bucketed under their parent in this
    // same sorted order (see the `childrenByParent` build in RepoGroup), making
    // archived primary also sinks archived children below live siblings within a
    // parent's brood.
    for (const [, group] of grouped) {
      group.sort((a, b) => {
        const aArchived = a.archived || a.userArchived ? 1 : 0;
        const bArchived = b.archived || b.userArchived ? 1 : 0;
        if (aArchived !== bArchived) return aArchived - bArchived;
        const aMerged = isRecentlyMerged(a) ? 1 : 0;
        const bMerged = isRecentlyMerged(b) ? 1 : 0;
        if (aMerged !== bMerged) return aMerged - bMerged;
        if (aMerged === 1) {
          const aKey = a.mergedAt ?? a.createdAt ?? "";
          const bKey = b.mergedAt ?? b.createdAt ?? "";
          return bKey.localeCompare(aKey);
        }
        return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      });
    }

    const known = repos.map((repo) => ({
      kind: "repo" as const,
      repo,
      sessions: grouped.get(repo.url) ?? [],
    }));
    const knownUrls = new Set(repos.map((repo) => repo.url));
    const orphan = [...grouped.entries()]
      .filter(([url, group]) => !knownUrls.has(url) && group.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([url, group]) => {
        let label = "Other sessions";
        if (url === "") {
          label = "Local sessions";
        } else {
          try {
            label = new URL(url).host || url;
          } catch {
            label = url;
          }
        }
        return { kind: "orphan" as const, url, label, sessions: group };
      });

    // docs/128 — pin the ops group at the very top when it exists.
    const ops = opsSessions.length > 0
      ? [{ kind: "ops" as const, sessions: opsSessions }]
      : [];

    // Ops first (pinned), then server-provided repo order, then non-empty unmatched groups.
    return [...ops, ...known, ...orphan];
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
  const handleSelectCurrent = mobile ? onClose : undefined;

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
          onClick={() => {
            // Prefer the current session's repo over `activeRepoUrl` —
            // `activeRepoUrl` doesn't get re-synced on URL-based navigation,
            // so it can point at a different repo than the session the user
            // is actually viewing.
            const session = useSessionStore.getState();
            const currentRepo = session.sessions.find((s) => s.id === session.sessionId)?.remoteUrl;
            const url = currentRepo ?? useRepoStore.getState().activeRepoUrl ?? repos[0]?.url;
            if (url) onNewSessionForRepo(url);
          }}
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
    <div className={`flex h-full min-h-0 ${mobile ? "w-full min-w-0" : "shrink-0"}`}>
    <div
      className={`flex flex-col h-full bg-(--color-bg-primary) ${mobile ? "min-w-0 flex-1" : "border-r border-(--color-border-primary)"} min-h-0`}
      style={mobile ? undefined : { width }}
    >
      {/* Top bar — desktop only. On mobile the drawer is toggled open/closed
          via the bottom tab bar's Sessions button, and the repo switcher lives
          in the header, so this strip would be redundant. Quick session lives
          in the header on desktop and the bottom tab bar on mobile. */}
      {!mobile && (
        <div className="flex items-center gap-2 px-3 h-10.25 border-b border-(--color-border-primary) shrink-0">
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
      )}

      {/* Scrollable grouped repo sections */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col py-1">
        {repoGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-8">
            <p className="text-xs text-(--color-text-tertiary) text-center">No repositories yet.</p>
            <Button variant="primary" onClick={onAddRepo} className="gap-1.5">
              <PlusIcon size={14} />
              Add Repository
            </Button>
          </div>
        ) : (
          repoGroups.map((group) => group.kind === "ops" ? (
            <OpsSessionGroup
              key="ops"
              sessions={group.sessions}
              currentSessionId={currentSessionId}
              isCollapsed={opsCollapsed}
              onToggleCollapse={toggleOpsCollapsed}
              onResume={onResume}
              onSelectCurrent={handleSelectCurrent}
              onArchive={onArchive}
              isTouch={isTouch}
            />
          ) : group.kind === "repo" ? (
            <RepoGroup
              key={group.repo.url}
              repo={group.repo}
              sessions={group.sessions}
              currentSessionId={currentSessionId}
              isNewSessionSelected={activeNewSessionRepoUrl === group.repo.url}
              isCollapsed={!isSingleRepo && collapsedRepos.has(group.repo.url)}
              onToggleCollapse={() => toggleRepoCollapsed(group.repo.url)}
              collapsedParents={collapsedParents}
              onToggleParentCollapsed={toggleParentCollapsed}
              onResume={onResume}
              onSelectCurrent={handleSelectCurrent}
              onArchive={onArchive}
              onNewSession={() => onNewSessionForRepo(group.repo.url)}
              onViewAll={() => handleViewAll(group.repo.url)}
              onProjectSettings={() => handleProjectSettings(group.repo.url)}
              onRemoveRepo={() => handleRemoveRepo(group.repo.url)}
              isTouch={isTouch}
              draggable={reorderEnabled}
              isBeingDragged={draggedRepoUrl === group.repo.url}
              dropIndicator={dropTarget?.url === group.repo.url ? dropTarget.position : null}
              onDragStart={handleDragStart(group.repo.url)}
              onDragOver={handleDragOver(group.repo.url)}
              onDragLeave={handleDragLeave(group.repo.url)}
              onDrop={handleDrop(group.repo.url)}
              onDragEnd={handleDragEnd}
            />
          ) : (
            <OrphanSessionGroup
              key={`orphan:${group.url}`}
              label={group.label}
              sessions={group.sessions}
              currentSessionId={currentSessionId}
              onResume={onResume}
              onSelectCurrent={handleSelectCurrent}
              onArchive={onArchive}
              isTouch={isTouch}
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
