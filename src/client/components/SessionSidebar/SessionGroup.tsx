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
import { repoColorVar } from "../../../server/shared/repo-colors.js";
import { isResolvedForGrouping } from "../../../server/shared/session-resolution.js";

/**
 * docs/254 — the per-group identity edge. A 3px colored line on the LEFT of the
 * group, plus a faint band on the header so it reads as a section header rather
 * than another row.
 *
 * Two things about this are load-bearing and were established by mocking it
 * (`docs/033-session-sidebar/mocks/repo-separation-spine.html`, option 5b):
 *
 * · The edge lives on the GROUP element, never on the header. The header is
 *   `sticky top-0`, so an edge on the header visibly breaks at the seam the
 *   moment it pins; on the group it paints behind the pinned band and the line
 *   stays continuous for the group's whole height.
 * · The band fill must be OPAQUE. Every `*-subtle` token is `rgba()`, and a
 *   translucent sticky header lets session rows scroll straight through it —
 *   which is why the band is a `color-mix` COMPOSITED over `--color-bg-primary`
 *   rather than the hue at low alpha, and why the header keeps an opaque
 *   background class underneath it in every state.
 */
function groupEdgeStyle(color: string | undefined): React.CSSProperties | undefined {
  return color ? { borderLeftWidth: 3, borderLeftStyle: "solid", borderLeftColor: color } : undefined;
}

/**
 * The header band: a wash of the group's OWN color rather than a neutral fill
 * (`header-band-weight.html`, option E). See `--repo-band-mix` in `index.css`
 * for why it's this faint.
 *
 * The result must be OPAQUE, because the header is sticky. Note `color-mix`
 * interpolates rather than compositing, so mixing over an opaque backdrop does
 * NOT launder a translucent input — the output alpha is the interpolated one.
 * Both inputs are therefore required to be opaque, which `repo-palette.test.ts`
 * asserts for the palette AND for the semantic tokens Ops and Sandbox pass in.
 */
export function groupBandFill(color: string): string {
  return `color-mix(in srgb, ${color} var(--repo-band-mix), var(--color-bg-primary))`;
}

function groupBandStyle(color: string | undefined): React.CSSProperties | undefined {
  return color ? { backgroundColor: groupBandFill(color) } : undefined;
}

/**
 * Always on the header, in every state. Not a layer *beneath* the wash — the
 * inline `background-color` simply wins where there is one. This is the FALLBACK
 * for the two states that produce no wash at all (unseparated, and a repo row
 * written before the color backfill), so a sticky header is never left
 * transparent for rows to scroll through.
 */
const HEADER_BASE_CLASS = "bg-(--color-bg-primary)";

export const GROUP_GAP_CLASS = "mb-1.5";

export const BAND_CLEARANCE_CLASS = "pt-1 pb-1";

export const ROW_GAP_CLASS = "gap-1";

export function OpsSessionGroup({
  sessions,
  currentSessionId,
  isCollapsed,
  onToggleCollapse,
  onResume,
  onSelectCurrent,
  onArchive,
  isTouch,
  separated,
}: {
  sessions: SessionInfo[];
  currentSessionId?: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onResume: (sessionId: string) => void;
  onSelectCurrent?: () => void;
  onArchive: (sessionId: string) => void;
  isTouch: boolean;

  separated?: boolean;
}) {
  if (sessions.length === 0) return null;

  const color = separated ? "var(--color-warning)" : undefined;
  const edge = groupEdgeStyle(color);
  return (
    <div className={`flex flex-col ${separated ? GROUP_GAP_CLASS : ""}`} style={edge} data-testid="ops-group">
      <div
        className={`flex items-center gap-1.5 pl-3.5 pr-3 py-1.5 sticky top-0 z-10 ${HEADER_BASE_CLASS}`}
        style={groupBandStyle(color)}
      >
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
        <div className={`flex flex-col ${ROW_GAP_CLASS} ${separated ? BAND_CLEARANCE_CLASS : ""}`}>
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

export function SandboxSessionGroup({
  sessions,
  currentSessionId,
  isCollapsed,
  onToggleCollapse,
  onResume,
  onSelectCurrent,
  onArchive,
  isTouch,
  separated,
}: {
  sessions: SessionInfo[];
  currentSessionId?: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onResume: (sessionId: string) => void;
  onSelectCurrent?: () => void;
  onArchive: (sessionId: string) => void;
  isTouch: boolean;

  separated?: boolean;
}) {
  if (sessions.length === 0) return null;

  const color = separated ? "var(--color-sandbox)" : undefined;
  const edge = groupEdgeStyle(color);
  return (
    <div className={`flex flex-col ${separated ? GROUP_GAP_CLASS : ""}`} style={edge} data-testid="sandbox-group">
      <div
        className={`flex items-center gap-1.5 pl-3.5 pr-3 py-1.5 sticky top-0 z-10 ${HEADER_BASE_CLASS}`}
        style={groupBandStyle(color)}
      >
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
        <div className={`flex flex-col ${ROW_GAP_CLASS} ${separated ? BAND_CLEARANCE_CLASS : ""}`}>
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
      <div className={`flex flex-col ${ROW_GAP_CLASS}`}>
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
  expandedResolvedChildren,
  onToggleResolvedChildren,
  onResume,
  onSelectCurrent,
  onArchive,
  onNewSession,
  onViewAll,
  onProjectSettings,
  onHideRepo,
  onRemoveRepo,
  isTouch,

  draggable,
  isBeingDragged,
  dropIndicator,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  separated,
}: {
  repo: RepoInfo;
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  isNewSessionSelected: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;

  isResolvedCollapsed: boolean;
  onToggleResolvedCollapsed: () => void;
  collapsedParents: Set<string>;
  onToggleParentCollapsed: (parentId: string) => void;

  expandedResolvedChildren: Set<string>;
  onToggleResolvedChildren: (rootId: string) => void;
  onResume: (id: string) => void;
  onSelectCurrent?: () => void;
  onArchive: (id: string) => void;
  onNewSession: () => void;
  onViewAll: () => void;
  onProjectSettings: () => void;
  onHideRepo: () => void;
  onRemoveRepo: () => void;
  isTouch: boolean;

  draggable: boolean;

  isBeingDragged: boolean;

  dropIndicator: DropPosition | null;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;

  separated: boolean;
}) {
  const repoName = parseRepoName(repo.url);

  const color = separated && repo.colorIndex !== undefined ? repoColorVar(repo.colorIndex) : undefined;
  const edge = groupEdgeStyle(color);

  const [listRef] = useAutoAnimate<HTMLDivElement>();

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

  const onPinDragStart = useCallback((id: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-shipit-pinned-session", id);
    e.dataTransfer.effectAllowed = "move";
    setPinDragId(id);
  }, []);
  const onPinDragOver = useCallback((id: string) => (e: React.DragEvent) => {
    if (!pinDragId) return;                                                   
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
    if (next.join("\n") === pinnedIds.join("\n")) return;                         
    void useSessionStore.getState().reorderPins(repo.url, next);
  }, [pinDragId, pinDropTarget, pinnedIds, repo.url]);
  const onPinDragEnd = useCallback(() => {
    setPinDragId(null);
    setPinDropTarget(null);
  }, []);

  return (
    <div
      className={`flex flex-col relative ${separated ? GROUP_GAP_CLASS : ""} ${isBeingDragged ? "opacity-40" : ""}`}

      style={edge}
      data-repo-color-index={separated ? repo.colorIndex : undefined}
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
        className={`flex items-center gap-1.5 pl-3.5 pr-3 py-1.5 sticky top-0 z-10 group/header ${HEADER_BASE_CLASS}`}
        style={groupBandStyle(color)}
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

              // because nothing is destroyed; normal styling, NOT the destructive

              onSelect={onHideRepo}
            >
              <EyeSlashIcon size={ICON_SIZE.XS} className="shrink-0" />
              Hide from sidebar
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem

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
        <div ref={listRef} data-testid="group-session-list" className={`flex flex-col ${ROW_GAP_CLASS} ${separated ? BAND_CLEARANCE_CLASS : "pb-2"}`}>
          {(() => {

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

            // a fallback so it never silently disappears from the sidebar.
            return (() => {

              // children, so a child-of-a-child was never rendered. A session whose

              // out) falls back to top level so it never silently disappears.
              const idsInGroup = new Set(sessions.map((s) => s.id));
              const broodByRoot = new Map<string, SessionInfo[]>();
              const orphanedChildren = new Set<string>();
              for (const s of sessions) {
                if (!s.rootSessionId) continue;                                          
                if (!idsInGroup.has(s.rootSessionId)) {
                  orphanedChildren.add(s.id);
                  continue;
                }
                const list = broodByRoot.get(s.rootSessionId) ?? [];
                list.push(s);
                broodByRoot.set(s.rootSessionId, list);
              }
              const isRecentlyResolvedForGroup = (s: SessionInfo): boolean =>
                isResolvedForGrouping(s, { hasVisibleBrood: broodByRoot.has(s.id) });

              // work is never automatically moved under "Recently resolved". The

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

                // never tucked away: hiding it would leave its own descendants

                const parentsInBrood = new Set<string>();
                for (const m of brood) {
                  if (m.parentSessionId) parentsInBrood.add(m.parentSessionId);
                }
                // A PINNED member is never tucked away either: docs/110 —

                const isResolvedMember = (m: SessionInfo): boolean =>
                  isResolvedForGrouping(m, { hasVisibleBrood: parentsInBrood.has(m.id) });
                const renderMember = (member: SessionInfo) => (
                  <SessionItem
                    key={member.id}
                    session={member}
                    isCurrent={member.id === currentSessionId}
                    onResume={onResume}
                    onSelectCurrent={onSelectCurrent}
                    onArchive={onArchive}
                    isTouch={isTouch}
                    indented
                  />
                );
                const resolvedMembers: SessionInfo[] = [];
                for (const member of brood) {
                  if (isResolvedMember(member)) resolvedMembers.push(member);
                  else target.push(renderMember(member));
                }

                if (resolvedMembers.length === 0) return;
                const resolvedShown = expandedResolvedChildren.has(s.id);
                const countLabel = `${resolvedMembers.length} resolved spawned session${resolvedMembers.length === 1 ? "" : "s"}`;
                target.push(
                  <button
                    key={`resolved-children-${s.id}`}
                    type="button"
                    data-testid="resolved-children-toggle"
                    onClick={() => onToggleResolvedChildren(s.id)}
                    aria-expanded={resolvedShown}
                    aria-label={resolvedShown ? `Hide ${countLabel}` : `Show ${countLabel}`}
                    className="group/resolvedkids flex items-center gap-1.5 px-2 pt-1 pb-0.5 mx-1 ml-5 text-left"
                  >
                    <GitMergeIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
                      {resolvedMembers.length} resolved
                    </span>
                    <span className="shrink-0 flex items-center text-(--color-text-tertiary) group-hover/resolvedkids:text-(--color-text-secondary) transition-colors">
                      {resolvedShown
                        ? <CaretDownIcon size={ICON_SIZE.XS} />
                        : <CaretRightIcon size={ICON_SIZE.XS} />
                      }
                    </span>
                  </button>,
                );
                if (!resolvedShown) return;
                for (const member of resolvedMembers) target.push(renderMember(member));
              };

              const pinned: React.ReactElement[] = pinnedSessions.map((s) => {
                const tree: React.ReactElement[] = [];
                pushTree(s, tree);
                return (
                  <div
                    key={`pin-${s.id}`}
                    data-testid="pinned-tree"
                    draggable={pinReorderEnabled}
                    onDragStart={pinReorderEnabled ? onPinDragStart(s.id) : undefined}
                    onDragOver={pinReorderEnabled ? onPinDragOver(s.id) : undefined}
                    onDragLeave={pinReorderEnabled ? onPinDragLeave(s.id) : undefined}
                    onDrop={pinReorderEnabled ? onPinDrop(s.id) : undefined}
                    onDragEnd={pinReorderEnabled ? onPinDragEnd : undefined}

                    className={`relative flex flex-col ${ROW_GAP_CLASS} ${pinDragId === s.id ? "opacity-40" : ""}`}
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

                if (s.rootSessionId && !orphanedChildren.has(s.id)) continue;
                if (pinnedIdSet.has(s.id)) continue;                                      
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
