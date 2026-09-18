import { useState, useCallback, useMemo } from "react";
import { CaretDownIcon, CaretRightIcon, CubeIcon, EyeIcon, EyeSlashIcon, GithubLogoIcon, LightningIcon, MicrophoneIcon, PlusIcon, SidebarSimpleIcon, WrenchIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { parseRepoName } from "../../utils/repo-label.js";
import { Button } from "../ui/button.js";
import { WithTooltip } from "../ui/tooltip.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel } from "../ui/dropdown-menu.js";
import { RepoSwitcher } from "../RepoSwitcher.js";
import { RemoveRepoDialog } from "../RemoveRepoDialog.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useRepoStore } from "../../stores/repo-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useMediaQuery } from "../../hooks/useMediaQuery.js";
import { useAttentionSessions } from "../../hooks/useAttentionSessions.js";
import type { SessionInfo, RepoInfo } from "../../../server/shared/types.js";
import { useSidebarResize } from "./useSidebarResize.js";
import { computeRepoGroups } from "./useSessionGrouping.js";
import { OpsSessionGroup, OrphanSessionGroup, RepoGroup, SandboxSessionGroup } from "./SessionGroup.js";
import { AttentionSessionList } from "./AttentionSessionList.js";
import { AttentionViewToggle } from "./AttentionViewToggle.js";

interface SessionSidebarProps {
  sessions: SessionInfo[];
  currentSessionId: string | undefined;

  activeNewSessionRepoUrl?: string;
  onResume: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onNewSessionForRepo: (repoUrl: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;

  repos: RepoInfo[];
  onAddRepo: () => void;
  onCreateNewRepo: () => void;

  mobile?: boolean;

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

  const isTouch = useMediaQuery("(pointer: coarse)");

  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);

  const collapsedRepos = useRepoStore((s) => s.collapsedRepos);
  const toggleRepoCollapsed = useRepoStore((s) => s.toggleRepoCollapsed);
  const collapsedParents = useRepoStore((s) => s.collapsedParents);
  const toggleParentCollapsed = useRepoStore((s) => s.toggleParentCollapsed);
  const collapsedResolved = useRepoStore((s) => s.collapsedResolved);
  const toggleResolvedCollapsed = useRepoStore((s) => s.toggleResolvedCollapsed);
  const expandedResolvedChildren = useRepoStore((s) => s.expandedResolvedChildren);
  const toggleResolvedChildrenExpanded = useRepoStore((s) => s.toggleResolvedChildrenExpanded);
  const opsCollapsed = useRepoStore((s) => s.opsCollapsed);
  const toggleOpsCollapsed = useRepoStore((s) => s.toggleOpsCollapsed);
  const sandboxCollapsed = useRepoStore((s) => s.sandboxCollapsed);
  const toggleSandboxCollapsed = useRepoStore((s) => s.toggleSandboxCollapsed);
  const hiddenReposCollapsed = useRepoStore((s) => s.hiddenReposCollapsed);
  const toggleHiddenReposCollapsed = useRepoStore((s) => s.toggleHiddenReposCollapsed);
  const reorderRepos = useRepoStore((s) => s.reorderRepos);

  const setSandboxDialogOpen = useUiStore((s) => s.setSandboxDialogOpen);

  const handleCreateOps = useCallback(async () => {
    const newId = await useSessionStore.getState().createOpsSession();
    if (newId) {
      onResume(newId);
      if (mobile) onClose?.();
    } else {
      useUiStore.getState().setToast({ message: "Failed to create ops session" });
    }
  }, [mobile, onClose, onResume]);

  const [draggedRepoUrl, setDraggedRepoUrl] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ url: string; position: "before" | "after" } | null>(null);

  const [removeRepoTarget, setRemoveRepoTarget] = useState<{ url: string; name: string; sessionCount: number } | null>(null);

  const hiddenRepos = useMemo(() => repos.filter((r) => r.hidden), [repos]);
  const visibleRepos = useMemo(() => repos.filter((r) => !r.hidden), [repos]);
  const hiddenUrls = useMemo(() => new Set(hiddenRepos.map((r) => r.url)), [hiddenRepos]);
  const visibleSessions = useMemo(
    () => (hiddenUrls.size === 0 ? sessions : sessions.filter((s) => !s.remoteUrl || !hiddenUrls.has(s.remoteUrl))),
    [sessions, hiddenUrls],
  );
  const repoGroups = useMemo(() => computeRepoGroups(visibleRepos, visibleSessions), [visibleRepos, visibleSessions]);

  // never appear in the other.
  const sidebarView = useUiStore((s) => s.sidebarView);
  const toggleSidebarView = useUiStore((s) => s.toggleSidebarView);
  const setSidebarView = useUiStore((s) => s.setSidebarView);
  const attentionIds = useAttentionSessions(visibleSessions);
  const attentionView = sidebarView === "attention";

  const collapseLabel = attentionView ? "Back to all sessions" : "Collapse sidebar";
  const onCollapsePress = attentionView ? () => setSidebarView("all") : onToggleCollapse;

  const handleViewAll = useCallback((repoUrl: string) => {

    // lands and is persisted, so merely looking at a repo's sessions must not

    useSessionStore.getState().setAllSessionsDialogOpen(true, repoUrl);

    if (mobile) onClose?.();
  }, [mobile, onClose]);

  const handleProjectSettings = useCallback((repoUrl: string) => {

    useUiStore.getState().setProjectSettingsRepoUrl(repoUrl);
    if (mobile) onClose?.();
  }, [mobile, onClose]);

  const handleRemoveRepo = useCallback((repoUrl: string) => {

    const count = sessions.filter(
      (s) => s.remoteUrl === repoUrl && !s.userArchived && !s.warm,
    ).length;
    setRemoveRepoTarget({ url: repoUrl, name: parseRepoName(repoUrl), sessionCount: count });
  }, [sessions]);

  const handleHideRepo = useCallback((repoUrl: string) => {
    void useRepoStore.getState().setRepoHidden(repoUrl, true);
  }, []);

  const handleShowRepo = useCallback((repoUrl: string) => {
    void useRepoStore.getState().setRepoHidden(repoUrl, false);
  }, []);

  const isSingleRepo = visibleRepos.length === 1;
  const handleSelectCurrent = mobile ? onClose : undefined;

  const reorderEnabled = visibleRepos.length > 1;

  const separated = repoGroups.length > 1;

  const handleDragStart = useCallback(
    (repoUrl: string) => (e: React.DragEvent) => {

      e.dataTransfer.setData("application/x-shipit-repo", repoUrl);
      e.dataTransfer.effectAllowed = "move";
      setDraggedRepoUrl(repoUrl);
    },
    [],
  );

  const handleDragOver = useCallback(
    (repoUrl: string) => (e: React.DragEvent) => {

      if (!draggedRepoUrl) return;

      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (repoUrl === draggedRepoUrl) {

        setDropTarget(null);
        return;
      }

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

      const current = repos.map((r) => r.url);
      const sourceIdx = current.indexOf(sourceUrl);
      if (sourceIdx === -1) return;
      current.splice(sourceIdx, 1);
      let targetIdx = current.indexOf(targetUrl);
      if (targetIdx === -1) return;
      if (position === "after") targetIdx += 1;
      current.splice(targetIdx, 0, sourceUrl);

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

  const renderAdvancedSessionMenu = (_side?: "top" | "right") => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="p-0! w-7 h-7 text-(--color-text-tertiary) hover:text-(--color-text-primary)"
          aria-label="New advanced session"
          title="New advanced session"
        >
          <PlusIcon size={ICON_SIZE.SM} weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>New session</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => { setSandboxDialogOpen(true); if (mobile) onClose?.(); }} className="items-start gap-2.5 py-2">
          <span className="w-7 h-7 rounded-md bg-(--color-sandbox-subtle) text-(--color-sandbox) flex items-center justify-center shrink-0">
            <CubeIcon size={ICON_SIZE.SM} weight="fill" />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-(--color-text-primary)">Sandbox session</span>
            <span className="block text-[11.5px] text-(--color-text-secondary) leading-snug">
              Empty workspace. Choose GitHub, Docker &amp; network access. The agent clones what it needs.
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void handleCreateOps()} className="items-start gap-2.5 py-2">
          <span className="w-7 h-7 rounded-md bg-(--color-warning-subtle) text-(--color-warning) flex items-center justify-center shrink-0">
            <WrenchIcon size={ICON_SIZE.SM} weight="fill" />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-(--color-text-primary)">Ops session</span>
            <span className="block text-[11.5px] text-(--color-text-secondary) leading-snug">
              Read-only host introspection — Docker proxy &amp; journal logs.
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

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
        {/* docs/260 — deliberately NO view switch on the collapsed rail. Req 5
            asks for the count in both VIEWS, not in both collapse states, and a
            40px rail can show no list: the control there could only be a
            one-way "expand into the attention view", which is a different
            action wearing the same glyph as the header's toggle. The rail
            already shows no session information at all; leaving it that way
            beats a second control with second semantics. */}
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
        {renderAdvancedSessionMenu("right")}
        {renderQuickSessionControls("right")}
        <div className="flex-1" />
        <WithTooltip label="New Session" side="right">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {

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
      {/* Top bar. Desktop: collapse + advanced "+" menu + quick/voice + repo
          switcher. Mobile drawer: the advanced "+" menu and the repo switcher
          (moved here from the app header to declutter it), right-aligned. There's
          no collapse/close affordance on mobile — Sessions is one mode of the
          bottom tab bar's segmented control, so you switch away from it (tap
          Chat/Workspace) rather than closing it. Quick session, voice, and "new
          session" also live in the bottom tab bar, so they're omitted here to
          avoid duplicating them. */}
      <div className="flex items-center gap-2 px-3 h-10.25 border-b border-(--color-border-primary) shrink-0">
        {!mobile && (
          <WithTooltip label={collapseLabel}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCollapsePress}
            className="p-0! w-7 h-7 text-(--color-text-tertiary)"
            aria-label={collapseLabel}
          >
            <SidebarSimpleIcon size={ICON_SIZE.SM} />
          </Button>
          </WithTooltip>
        )}
        {/* docs/260-attention-sidebar-view req 4 — the view switch belongs with the collapse control
            (both act on the sidebar itself), not in the right-hand cluster of
            create/act controls. The mobile bar has no collapse control, so the
            slot is free and the switch is simply first (req 15). */}
        <AttentionViewToggle
          active={attentionView}
          count={attentionIds.size}
          onToggle={toggleSidebarView}
        />
        <span className="flex-1" />
        {renderAdvancedSessionMenu()}
        {!mobile && renderQuickSessionControls()}
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

      {/* The list body: the grouped repo tree, or docs/260's flat
          needs-attention list. Both scroll in this same container — the second
          view adds no chrome of its own above the list (req 10). */}
      <div

        className={`flex-1 overflow-y-auto min-h-0 flex flex-col pb-1 ${!attentionView && separated ? "" : "pt-1"}`}
      >
        {attentionView ? (
          <AttentionSessionList
            sessions={visibleSessions}
            attentionIds={attentionIds}
            currentSessionId={currentSessionId}
            onResume={onResume}
            onSelectCurrent={handleSelectCurrent}
            onArchive={onArchive}
            isTouch={isTouch}
          />
        ) : (
          <>
        {repoGroups.length === 0 && hiddenRepos.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-8">
            <p className="text-xs text-(--color-text-tertiary) text-center">No repositories yet.</p>
            <Button variant="primary" onClick={onAddRepo} className="gap-1.5">
              <PlusIcon size={14} />
              Add Repository
            </Button>
          </div>
        ) : (
          repoGroups.map((group) => group.kind === "sandbox" ? (
            <SandboxSessionGroup
              key="sandbox"
              sessions={group.sessions}
              currentSessionId={currentSessionId}
              isCollapsed={sandboxCollapsed}
              onToggleCollapse={toggleSandboxCollapsed}
              onResume={onResume}
              onSelectCurrent={handleSelectCurrent}
              onArchive={onArchive}
              isTouch={isTouch}
              separated={separated}
            />
          ) : group.kind === "ops" ? (
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
              separated={separated}
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
              isResolvedCollapsed={collapsedResolved.has(group.repo.url)}
              onToggleResolvedCollapsed={() => toggleResolvedCollapsed(group.repo.url)}
              collapsedParents={collapsedParents}
              onToggleParentCollapsed={toggleParentCollapsed}
              expandedResolvedChildren={expandedResolvedChildren}
              onToggleResolvedChildren={toggleResolvedChildrenExpanded}
              onResume={onResume}
              onSelectCurrent={handleSelectCurrent}
              onArchive={onArchive}
              onNewSession={() => onNewSessionForRepo(group.repo.url)}
              onViewAll={() => handleViewAll(group.repo.url)}
              onProjectSettings={() => handleProjectSettings(group.repo.url)}
              onHideRepo={() => handleHideRepo(group.repo.url)}
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
              separated={separated}
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

        {/* docs/222 — "Hidden" section: repos the user hid to declutter. A
            collapsible footer (collapsed by default) that expands to unhide each
            repo inline, so it's reachable without re-running the Add flow. Only
            renders when something is hidden, so it's invisible otherwise. */}
        {hiddenRepos.length > 0 && (
          <div className="flex flex-col mt-1 border-t border-(--color-border-primary)">
            <button
              onClick={toggleHiddenReposCollapsed}
              className="flex items-center gap-1.5 pl-3.5 pr-3 py-1.5 text-left group"
              aria-label={hiddenReposCollapsed ? "Expand hidden repositories" : "Collapse hidden repositories"}
            >
              <span className="w-5 h-5 flex items-center justify-center shrink-0 text-(--color-text-tertiary) group-hover:text-(--color-text-secondary)">
                {hiddenReposCollapsed
                  ? <CaretRightIcon size={ICON_SIZE.XS} />
                  : <CaretDownIcon size={ICON_SIZE.XS} />
                }
              </span>
              <EyeSlashIcon size={ICON_SIZE.XS} weight="fill" className="shrink-0 text-(--color-text-tertiary)" />
              <span className="text-xs font-semibold text-(--color-text-tertiary) truncate tracking-wide group-hover:text-(--color-text-secondary) transition-colors">
                Hidden
              </span>
              <span className="text-xs text-(--color-text-tertiary) font-medium">· {hiddenRepos.length}</span>
            </button>
            {!hiddenReposCollapsed && (
              <div className="flex flex-col gap-0.5 pb-1">
                {hiddenRepos.map((repo) => (
                  <div
                    key={repo.url}
                    className="group/hidden flex items-center gap-1.5 mx-1 pl-7 pr-2 py-1.5 rounded text-xs text-(--color-text-tertiary) hover:bg-(--color-bg-hover) transition-colors"
                  >
                    <GithubLogoIcon size={ICON_SIZE.XS} weight="fill" className="shrink-0 opacity-60" />
                    <span className="truncate flex-1" title={parseRepoName(repo.url)}>{parseRepoName(repo.url)}</span>
                    <button
                      onClick={() => handleShowRepo(repo.url)}
                      className="ml-auto flex items-center gap-1 shrink-0 text-[11px] text-(--color-text-link) px-1.5 py-0.5 rounded hover:bg-(--color-bg-secondary) opacity-0 group-hover/hidden:opacity-100 focus:opacity-100 transition-opacity"
                      aria-label={`Show ${parseRepoName(repo.url)}`}
                    >
                      <EyeIcon size={ICON_SIZE.XS} className="shrink-0" />
                      Show
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
          </>
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
