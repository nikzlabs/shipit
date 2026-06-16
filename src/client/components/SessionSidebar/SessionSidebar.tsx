import { useState, useCallback, useMemo } from "react";
import { GithubLogoIcon, LightningIcon, MicrophoneIcon, PlusIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { parseRepoName } from "../../utils/repo-label.js";
import { Button } from "../ui/button.js";
import { WithTooltip } from "../ui/tooltip.js";
import { RepoSwitcher } from "../RepoSwitcher.js";
import { RemoveRepoDialog } from "../RemoveRepoDialog.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useRepoStore } from "../../stores/repo-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useMediaQuery } from "../../hooks/useMediaQuery.js";
import type { SessionInfo, RepoInfo } from "../../../server/shared/types.js";
import { useSidebarResize } from "./useSidebarResize.js";
import { computeRepoGroups } from "./useSessionGrouping.js";
import { OpsSessionGroup, OrphanSessionGroup, RepoGroup } from "./SessionGroup.js";

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
  // Desktop voice quick-session button only renders when voice input is on,
  // mirroring how the mobile auto-mic flow is gated (avoids a redundant
  // second lightning glyph for users who don't use voice).
  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);

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

  // Repo-removal confirmation dialog target (null = closed). Holds the repo URL,
  // display name, and the count of sessions that will be archived so the dialog
  // can spell out the consequences before the destructive action runs.
  const [removeRepoTarget, setRemoveRepoTarget] = useState<{ url: string; name: string; sessionCount: number } | null>(null);

  const repoGroups = useMemo(() => computeRepoGroups(repos, sessions), [repos, sessions]);

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
    // Backend semantics (api-routes-session.ts DELETE /api/repos/:url + docs/059):
    // the repo entry and its warm session are removed, and every real session for
    // the repo is archived — hidden from the sidebar, disk reclaimed, DB row kept.
    // Removal is consequential enough (it can drop uncommitted working copies) to
    // warrant an explicit deleted-vs-kept dialog rather than an inline confirm.
    const count = sessions.filter(
      (s) => s.remoteUrl === repoUrl && !s.userArchived && !s.warm,
    ).length;
    setRemoveRepoTarget({ url: repoUrl, name: parseRepoName(repoUrl), sessionCount: count });
  }, [sessions]);

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

  // Quick-session controls live in the sidebar's own toolbar (and collapsed
  // rail) rather than the app header. The plain lightning opens the quick
  // capture overlay; the lightning+mic variant opens it with auto-mic on and
  // only renders when voice input is enabled. `side` lets the collapsed rail
  // anchor its tooltips to the right.
  const renderQuickSessionControls = (side?: "top" | "right") => (
    <>
      <WithTooltip label="Quick session" side={side}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => useUiStore.getState().setQuickCaptureOpen(true)}
          className="p-0! w-7 h-7 text-(--color-text-tertiary) hover:text-(--color-text-primary)"
          aria-label="Quick session"
        >
          <LightningIcon size={ICON_SIZE.SM} />
        </Button>
      </WithTooltip>
      {voiceInputEnabled && (
        <WithTooltip label="Voice quick session" side={side}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useUiStore.getState().setQuickCaptureOpen(true, true)}
            className="p-0! w-7 h-7 text-(--color-text-tertiary) hover:text-(--color-text-primary)"
            aria-label="Voice quick session"
          >
            <span className="relative inline-flex h-4 w-4 items-center justify-center">
              <LightningIcon size={ICON_SIZE.SM} />
              <MicrophoneIcon
                size={ICON_SIZE.XS}
                weight="fill"
                className="absolute -bottom-0.5 -right-1 rounded-full bg-(--color-bg-primary)"
              />
            </span>
          </Button>
        </WithTooltip>
      )}
    </>
  );

  if (collapsed && !mobile) {
    return (
      <div className="flex flex-col w-10 h-full shrink-0 bg-(--color-bg-primary) border-r border-(--color-border-primary) items-center py-2 gap-2">
        <WithTooltip label="Expand sidebar" side="right">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleCollapse}
          className="p-0! w-7 h-7"
          aria-label="Expand sidebar"
        >
          <SidebarSimpleIcon size={ICON_SIZE.SM} />
        </Button>
        </WithTooltip>
        <RepoSwitcher repos={repos} activeRepoUrl={useRepoStore.getState().activeRepoUrl} onSelectRepo={(url) => useRepoStore.getState().setActiveRepoUrl(url)} onAddRepo={onAddRepo} onCreateNew={onCreateNewRepo}>
        <Button
          variant="ghost"
          size="sm"
          className="p-0! w-7 h-7 text-(--color-text-secondary) hover:text-(--color-text-primary)"
          aria-label="Repository"
        >
          <GithubLogoIcon size={ICON_SIZE.SM} weight="fill" className="shrink-0" />
        </Button>
        </RepoSwitcher>
        {renderQuickSessionControls("right")}
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
          className="p-0! w-7 h-7 text-(--color-success) hover:text-(--color-success)"
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
            className="p-0! w-7 h-7 text-(--color-text-tertiary)"
            aria-label="Collapse sidebar"
          >
            <SidebarSimpleIcon size={ICON_SIZE.SM} />
          </Button>
          </WithTooltip>
          <span className="flex-1" />
          {renderQuickSessionControls()}
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
              className="p-0! w-7 h-7 text-(--color-text-tertiary) hover:text-(--color-text-primary)"
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
    {/* Repo-removal confirmation (Radix portals, so placement here is fine) */}
    <RemoveRepoDialog
      open={removeRepoTarget !== null}
      repoName={removeRepoTarget?.name ?? ""}
      sessionCount={removeRepoTarget?.sessionCount ?? 0}
      onClose={() => setRemoveRepoTarget(null)}
      onConfirm={() => {
        if (removeRepoTarget) void useRepoStore.getState().removeRepo(removeRepoTarget.url);
        setRemoveRepoTarget(null);
      }}
    />
    </div>
  );
}
