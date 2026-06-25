import { useState, useCallback, useMemo } from "react";
import { CubeIcon, DotsSixVerticalIcon, EyeSlashIcon, GithubLogoIcon, GitMergeIcon, ListBulletsIcon, PlusIcon, PushPinIcon, TrashIcon, WrenchIcon, SlidersHorizontalIcon, CaretRightIcon, CaretDownIcon } from "@phosphor-icons/react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { parseRepoName } from "../../utils/repo-label.js";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu.js";
import { OverflowMenu } from "../ui/overflow-menu.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { SessionInfo, RepoInfo } from "../../../server/shared/types.js";
import { SessionItem } from "./SessionItem.js";
import { isRecentlyResolved } from "./useSessionGrouping.js";

/**
 * docs/128 — pinned group for privileged ops/host-debugging sessions. Keyed off
 * the server-authoritative `kind: "ops"` field, separate from repo and orphan
 * groups, with a Wrench icon so it reads as "the host tools" rather than a repo.
 */
export function OpsSessionGroup({
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
        <div className="flex flex-col gap-1">
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

/**
 * docs/211 — pinned group for repo-less, capability-scoped sandbox sessions.
 * Keyed off the server-authoritative `kind: "sandbox"` field (NOT the orphan
 * `remoteUrl ?? ""` bucket), with a teal Cube icon distinguishing it from the
 * amber ops group and repo groups.
 */
export function SandboxSessionGroup({
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
          aria-label={isCollapsed ? "Expand Sandbox" : "Collapse Sandbox"}
        >
          <span className="w-5 h-5 flex items-center justify-center shrink-0 text-(--color-text-tertiary) group-hover:text-(--color-text-secondary)">
            {isCollapsed
              ? <CaretRightIcon size={ICON_SIZE.XS} />
              : <CaretDownIcon size={ICON_SIZE.XS} />
            }
          </span>
          <CubeIcon size={ICON_SIZE.XS} weight="fill" className="shrink-0 text-(--color-sandbox)" />
          <span className="text-xs font-semibold text-(--color-text-secondary) truncate tracking-wide group-hover:text-(--color-text-primary) transition-colors">
            Sandbox
          </span>
        </button>
      </div>
      {!isCollapsed && (
        <div className="flex flex-col gap-1">
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
export type DropPosition = "before" | "after";

export function OrphanSessionGroup({
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
      <div className="flex flex-col gap-1">
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
export function RepoGroup({
  repo,
  sessions,
  currentSessionId,
  isNewSessionSelected,
  isCollapsed,
  onToggleCollapse,
  isResolvedCollapsed,
  onToggleResolvedCollapsed,
  collapsedParents,
  onToggleParentCollapsed,
  onResume,
  onSelectCurrent,
  onArchive,
  onNewSession,
  onViewAll,
  onProjectSettings,
  onHideRepo,
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
  /** docs/161 — whether this repo's "Recently resolved" sub-section is collapsed. */
  isResolvedCollapsed: boolean;
  onToggleResolvedCollapsed: () => void;
  collapsedParents: Set<string>;
  onToggleParentCollapsed: (parentId: string) => void;
  onResume: (id: string) => void;
  onSelectCurrent?: () => void;
  onArchive: (id: string) => void;
  onNewSession: () => void;
  onViewAll: () => void;
  onProjectSettings: () => void;
  onHideRepo: () => void;
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

  // FLIP animation for session rows reordering (PR merged sinks to bottom) or
  // exiting (archive). Library defaults — single duration/easing per parent,
  // respects prefers-reduced-motion automatically. See docs/148.
  const [listRef] = useAutoAnimate<HTMLDivElement>();

  // docs/110 Phase 2 — drag-to-reorder within the pinned set. Ordered pinned
  // top-level sessions for THIS repo group (a child whose parent is in the group
  // renders under the parent, so it's excluded here). Reorder rewrites pinnedAt.
  const pinnedSessions = useMemo(() => {
    const inGroup = new Set(sessions.map((s) => s.id));
    return sessions
      .filter((s) => !!s.pinnedAt && !s.userArchived && (!s.parentSessionId || !inGroup.has(s.parentSessionId)))
      .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""));
  }, [sessions]);
  const pinnedIds = useMemo(() => pinnedSessions.map((s) => s.id), [pinnedSessions]);
  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const pinReorderEnabled = pinnedSessions.length > 1;

  const [pinDragId, setPinDragId] = useState<string | null>(null);
  const [pinDropTarget, setPinDropTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);

  // Native HTML5 DnD, gated by a session-scoped MIME type so a stray text drag
  // can't look like a pin reorder (mirrors the repo-group reordering above).
  const onPinDragStart = useCallback((id: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-shipit-pinned-session", id);
    e.dataTransfer.effectAllowed = "move";
    setPinDragId(id);
  }, []);
  const onPinDragOver = useCallback((id: string) => (e: React.DragEvent) => {
    if (!pinDragId) return; // not a pin-reorder drag — let other drops bubble
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id === pinDragId) { setPinDropTarget(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const position: "before" | "after" = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setPinDropTarget((prev) => (prev?.id === id && prev.position === position ? prev : { id, position }));
  }, [pinDragId]);
  const onPinDragLeave = useCallback((id: string) => (e: React.DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setPinDropTarget((prev) => (prev?.id === id ? null : prev));
  }, []);
  const onPinDrop = useCallback((targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("application/x-shipit-pinned-session") || pinDragId;
    const position = pinDropTarget?.position;
    setPinDragId(null);
    setPinDropTarget(null);
    if (!sourceId || sourceId === targetId || !position) return;
    const next = [...pinnedIds];
    const sourceIdx = next.indexOf(sourceId);
    if (sourceIdx === -1) return;
    next.splice(sourceIdx, 1);
    let targetIdx = next.indexOf(targetId);
    if (targetIdx === -1) return;
    if (position === "after") targetIdx += 1;
    next.splice(targetIdx, 0, sourceId);
    if (next.join("\n") === pinnedIds.join("\n")) return; // dropped back in place
    void useSessionStore.getState().reorderPins(repo.url, next);
  }, [pinDragId, pinDropTarget, pinnedIds, repo.url]);
  const onPinDragEnd = useCallback(() => {
    setPinDragId(null);
    setPinDropTarget(null);
  }, []);

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
              // docs/222 — pure visibility toggle: drops the repo (and its
              // sessions) from the sidebar without archiving anything. Reversible
              // via the "Hidden" section or by re-adding. Acts inline (no confirm)
              // because nothing is destroyed; normal styling, NOT the destructive
              // red reserved for Remove below.
              onSelect={onHideRepo}
            >
              <EyeSlashIcon size={ICON_SIZE.XS} className="shrink-0" />
              Hide from sidebar
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              // Opens a confirmation dialog (RemoveRepoDialog) rather than acting
              // inline: removal archives every session and reclaims their disk, so
              // the user gets an explicit deleted-vs-kept breakdown first.
              onSelect={onRemoveRepo}
              className="text-(--color-error) hover:text-(--color-error) focus:text-(--color-error)"
            >
              <TrashIcon size={ICON_SIZE.XS} className="shrink-0" />
              Remove Repository
            </DropdownMenuItem>
        </OverflowMenu>
      </div>

      {/* Session list — hidden when collapsed */}
      {!isCollapsed && (
        <div ref={listRef} className="flex flex-col gap-1 pb-2">
          {(() => {
            // New session row — matches SessionItem shape so it can render as
            // selected. docs/110 — rendered below the pinned sub-section (see the
            // return) so pinned sessions stay anchored to the very top; when there
            // are no sessions at all it's the only row.
            const newSessionButton = (
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
            );
            if (sessions.length === 0) return newSessionButton;
            // docs/117 Phase 2 — render agent-spawned children indented under
            // their parent. We bucket children by `parentSessionId`, iterate
            // top-level sessions in the existing stable order, then immediately
            // follow each parent with its children (also in stable order). A
            // child whose parent isn't visible in this repo group (archived
            // out of the list, cross-repo, etc.) is rendered at top level as
            // a fallback so it never silently disappears from the sidebar.
            return (() => {
              // docs/201 — bucket the whole spawn brood (children + grandchildren
              // + deeper) by its ROOT ancestor, so descendants at any depth render
              // under one top-level session at a single indent level. Keying off
              // `rootSessionId` (not the immediate `parentSessionId`) is what makes
              // a grandchild visible: the old one-level map only nested direct
              // children, so a child-of-a-child was never rendered. A session whose
              // root isn't present in this repo group (cross-repo, archived/merged
              // out) falls back to top level so it never silently disappears.
              const idsInGroup = new Set(sessions.map((s) => s.id));
              const broodByRoot = new Map<string, SessionInfo[]>();
              const orphanedChildren = new Set<string>();
              for (const s of sessions) {
                if (!s.rootSessionId) continue; // top-level session, not part of a brood
                if (!idsInGroup.has(s.rootSessionId)) {
                  orphanedChildren.add(s.id);
                  continue;
                }
                const list = broodByRoot.get(s.rootSessionId) ?? [];
                list.push(s);
                broodByRoot.set(s.rootSessionId, list);
              }
              const isRecentlyResolvedForGroup = (s: SessionInfo): boolean =>
                isRecentlyResolved(s) && !broodByRoot.has(s.id);
              // Render a top-level (root) session followed by its (non-collapsed)
              // brood into `target`. The brood stays together; a root with a
              // visible brood stays Active even after its PR resolves so spawned
              // work is never automatically moved under "Recently resolved".
              const pushTree = (s: SessionInfo, target: React.ReactElement[]) => {
                const brood = broodByRoot.get(s.id);
                const childCount = brood?.length ?? 0;
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
                if (!brood || childrenCollapsed) return;
                for (const member of brood) {
                  target.push(
                    <SessionItem
                      key={member.id}
                      session={member}
                      isCurrent={member.id === currentSessionId}
                      onResume={onResume}
                      onSelectCurrent={onSelectCurrent}
                      onArchive={onArchive}
                      isTouch={isTouch}
                      indented
                    />,
                  );
                }
              };
              // docs/161 — split into Active and a demoted "Recently resolved"
              // group (merged OR closed-without-merge). The session list is
              // already sorted (active first, then resolved by resolve time
              // desc), so iterating in order keeps each group sorted.
              // docs/110 — pinned (persistent) sessions form a sub-section pinned
              // to the top of the repo group (ordered by pinnedAt desc; see the
              // component-level pinnedSessions memo). Each pin's tree is wrapped in
              // a draggable shell for Phase 2 reordering, and skipped in the
              // Active/Resolved split below so a pin outranks recency + demotion.
              const pinned: React.ReactElement[] = pinnedSessions.map((s) => {
                const tree: React.ReactElement[] = [];
                pushTree(s, tree);
                return (
                  <div
                    key={`pin-${s.id}`}
                    draggable={pinReorderEnabled}
                    onDragStart={pinReorderEnabled ? onPinDragStart(s.id) : undefined}
                    onDragOver={pinReorderEnabled ? onPinDragOver(s.id) : undefined}
                    onDragLeave={pinReorderEnabled ? onPinDragLeave(s.id) : undefined}
                    onDrop={pinReorderEnabled ? onPinDrop(s.id) : undefined}
                    onDragEnd={pinReorderEnabled ? onPinDragEnd : undefined}
                    className={`relative ${pinDragId === s.id ? "opacity-40" : ""}`}
                  >
                    {pinDropTarget?.id === s.id && pinDropTarget.position === "before" && (
                      <div className="absolute left-2 right-2 -top-px h-0.5 bg-(--color-success) z-20 rounded-full pointer-events-none" />
                    )}
                    {tree}
                    {pinDropTarget?.id === s.id && pinDropTarget.position === "after" && (
                      <div className="absolute left-2 right-2 -bottom-px h-0.5 bg-(--color-success) z-20 rounded-full pointer-events-none" />
                    )}
                  </div>
                );
              });
              const active: React.ReactElement[] = [];
              const resolved: React.ReactElement[] = [];
              for (const s of sessions) {
                // docs/201 — skip brood members; they render beneath their root
                // (keyed by rootSessionId). Orphans (root not in this group) fall
                // through to render at top level.
                if (s.rootSessionId && !orphanedChildren.has(s.id)) continue;
                if (pinnedIdSet.has(s.id)) continue; // rendered in the pinned sub-section
                pushTree(s, isRecentlyResolvedForGroup(s) ? resolved : active);
              }
              return (
                <>
                  {pinned.length > 0 && (
                    <div className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 mx-1" aria-hidden>
                      <PushPinIcon size={ICON_SIZE.XS} weight="fill" className="shrink-0 text-(--color-text-tertiary)" />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
                        Pinned
                      </span>
                    </div>
                  )}
                  {pinned}
                  {/* docs/110 — divider closes the pinned sub-section. The New
                      session row always follows, so render it whenever there are
                      pinned sessions to keep the sub-section visually distinct. */}
                  {pinned.length > 0 && (
                    <div
                      data-testid="pinned-divider"
                      className="h-px bg-(--color-border-primary) mx-3 mt-1.5 mb-0.5"
                      aria-hidden
                    />
                  )}
                  {newSessionButton}
                  {active}
                  {/* docs/161 — collapsible "Recently resolved" sub-section.
                      Expanded by default; the per-repo collapsed state is
                      remembered (repo-store → localStorage). The caret hugs the
                      label (variant E) rather than sitting in the right gutter,
                      so it reads as part of the section title instead of echoing
                      the repo header's own left caret one indent up. The whole
                      row is the hit target for a forgiving click area. */}
                  {resolved.length > 0 && (
                    <button
                      type="button"
                      onClick={onToggleResolvedCollapsed}
                      aria-expanded={!isResolvedCollapsed}
                      aria-label={isResolvedCollapsed ? "Expand recently resolved" : "Collapse recently resolved"}
                      className="group/resolved flex items-center gap-1.5 px-3 pt-2 pb-0.5 mx-1 text-left"
                    >
                      <GitMergeIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
                        Recently resolved
                      </span>
                      <span className="shrink-0 flex items-center text-(--color-text-tertiary) group-hover/resolved:text-(--color-text-secondary) transition-colors">
                        {isResolvedCollapsed
                          ? <CaretRightIcon size={ICON_SIZE.XS} />
                          : <CaretDownIcon size={ICON_SIZE.XS} />
                        }
                      </span>
                    </button>
                  )}
                  {!isResolvedCollapsed && resolved}
                </>
              );
            })();
          })()}
        </div>
      )}
    </div>
  );
}
