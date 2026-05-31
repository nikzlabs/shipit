import type { ReactNode, RefObject } from "react";
import { GaugeIcon, GearSixIcon, GithubLogoIcon, ListIcon, QuestionIcon } from "@phosphor-icons/react";
import { useRepoStore } from "./stores/repo-store.js";
import { ICON_SIZE } from "./design-tokens.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { WithTooltip } from "./components/ui/tooltip.js";
import { Button } from "./components/ui/button.js";
import { RepoSwitcher } from "./components/RepoSwitcher.js";
import { ThemePicker } from "./components/ThemePicker.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { MobileTabBar } from "./components/MobileTabBar.js";
import { Toast } from "./components/Toast.js";
import type { WsStatus } from "./hooks/useWebSocket.js";
import { type Theme } from "./hooks/useTheme.js";
import type { SessionInfo, RepoInfo, DockerMemoryStats, SubscriptionLimitsMap } from "../server/shared/types.js";
import { DockerMemoryBadge } from "./components/DockerMemoryBadge.js";
import { UptimeBadge } from "./components/UptimeBadge.js";
import { SubscriptionLimitsBadge } from "./components/SubscriptionLimitsBadge.js";
import { MobileStatusPanel } from "./components/MobileStatusPanel.js";
import { MemoryPressureBanner } from "./components/MemoryPressureBanner.js";
import { GitHubRateLimitBanner } from "./components/GitHubRateLimitBanner.js";
import { LocalModeBanner } from "./components/LocalModeBanner.js";
import { QuickCaptureOverlay } from "./components/QuickCaptureOverlay.js";

interface AppLayoutProps {
  // Header
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
  onSettingsOpen: () => void;
  onShortcutsOpen: () => void;
  hasSystemPrompt: boolean;
  githubAuthenticated: boolean;
  dockerMemory: DockerMemoryStats | null;
  /** Epoch ms when the orchestrator process started. null until SSE handshake completes. */
  processStartedAt: number | null;
  /** Per-agent subscription rate-limit snapshots driven by the `subscription_limits` SSE broadcast. */
  subscriptionLimits: SubscriptionLimitsMap;
  onNavigateHome: () => void;
  onOpenSessions: () => void;

  // Connection
  showConnectionBanner: boolean;
  connectionStatus: WsStatus;
  reconnectAttempt: number;
  onReconnect: () => void;

  // Layout
  isMobile: boolean;
  showHomeScreen: boolean;
  showNewSessionView: boolean;
  mobilePanel: "chat" | "preview";
  onMobilePanelChange: (panel: "chat" | "preview") => void;
  onMobileNewSession: () => void;
  onMobileQuickSession: () => void;
  onMobileVoiceSession: () => void;
  chatPanel: ReactNode;
  rightPanel: ReactNode;

  // Resize
  fraction: number;
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  containerRef: RefObject<HTMLDivElement | null>;

  // Sidebar
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  /** Repo URL whose "New session" slot should render as selected (user is on /{slug}/new). */
  activeNewSessionRepoUrl: string | undefined;
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  onCloseMobileSidebar: () => void;
  onResumeSession: (sid: string) => void;
  onArchiveSession: (sid: string) => Promise<void>;
  onNewSessionForRepo: (repoUrl: string) => void;
  onToggleSidebarCollapse: () => void;

  // Repo
  repos: RepoInfo[];
  onAddRepo: () => void;
  onCreateNewRepo: () => void;

  // Toast
  toast: { message: string } | null;
}

export function AppLayout({
  theme,
  onSelectTheme,
  onSettingsOpen,
  onShortcutsOpen,
  hasSystemPrompt,
  githubAuthenticated,
  dockerMemory,
  processStartedAt,
  subscriptionLimits,
  onNavigateHome,
  onOpenSessions,
  showConnectionBanner,
  connectionStatus,
  reconnectAttempt,
  onReconnect,
  isMobile,
  showHomeScreen,
  showNewSessionView,
  mobilePanel,
  onMobilePanelChange,
  onMobileNewSession,
  onMobileQuickSession,
  onMobileVoiceSession,
  chatPanel,
  rightPanel,
  fraction,
  isDragging,
  onMouseDown,
  onTouchStart,
  containerRef,
  sessions,
  currentSessionId,
  activeNewSessionRepoUrl,
  sidebarCollapsed,
  mobileSidebarOpen,
  onCloseMobileSidebar,
  onResumeSession,
  onArchiveSession,
  onNewSessionForRepo,
  onToggleSidebarCollapse,
  repos,
  onAddRepo,
  onCreateNewRepo,
  toast,
}: AppLayoutProps) {
  return (
    <>
      <MemoryPressureBanner stats={dockerMemory} />
      <GitHubRateLimitBanner />
      <LocalModeBanner />
      <header className="relative flex items-center justify-between px-3 sm:px-6 py-2 sm:py-3 border-b border-(--color-border-primary)">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          {isMobile && (
            <WithTooltip label="Sessions">
            <button onClick={onOpenSessions} className="inline-flex items-center justify-center w-7 h-7 rounded transition-colors text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)" aria-label="Sessions">
              <ListIcon size={ICON_SIZE.MD} />
            </button>
            </WithTooltip>
          )}
          <h1 className="text-base sm:text-lg font-semibold tracking-tight shrink-0 flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity" onClick={onNavigateHome} role="link">
            <img src="/favicon.svg" alt="" className="w-5 h-5" />
            ShipIt
          </h1>
          {isMobile && (
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
                className="p-0! w-7 h-7 text-(--color-text-secondary) hover:text-(--color-text-primary)"
                aria-label="Repository"
              >
                <GithubLogoIcon size={ICON_SIZE.MD} weight="fill" className="shrink-0" />
              </Button>
            </RepoSwitcher>
          )}
        </div>
        {showConnectionBanner && (
          isMobile ? (
            // Mobile: float the pill just BELOW the header so it never overlaps
            // (and blocks taps on) the title or the action buttons. Positioned
            // with top-full so it overlays the content area without shifting
            // layout when the connection blips.
            <div className="absolute left-0 right-0 top-full z-30 flex justify-center px-3 pt-1.5 pointer-events-none">
              <div className="pointer-events-auto max-w-full">
                <ConnectionBanner status={connectionStatus} reconnectAttempt={reconnectAttempt} onReconnect={onReconnect} compact />
              </div>
            </div>
          ) : (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[60vw] pointer-events-none flex justify-center">
              <div className="pointer-events-auto">
                <ConnectionBanner status={connectionStatus} reconnectAttempt={reconnectAttempt} onReconnect={onReconnect} />
              </div>
            </div>
          )
        )}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className="hidden sm:contents">
            <SubscriptionLimitsBadge limits={subscriptionLimits} />
            {processStartedAt !== null && <UptimeBadge processStartedAt={processStartedAt} />}
            {dockerMemory && <DockerMemoryBadge stats={dockerMemory} />}
          </div>
          {(processStartedAt !== null || dockerMemory !== null || Object.values(subscriptionLimits).some((s) => s)) && (
            <div className="sm:hidden">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    className="inline-flex items-center justify-center w-7 h-7 rounded transition-colors text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"
                    aria-label="Status"
                  >
                    <GaugeIcon size={ICON_SIZE.SM} />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-auto max-w-[calc(100vw-1.5rem)] p-3">
                  <MobileStatusPanel
                    subscriptionLimits={subscriptionLimits}
                    dockerMemory={dockerMemory}
                    processStartedAt={processStartedAt}
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}
          <WithTooltip label="Keyboard shortcuts">
          <button onClick={onShortcutsOpen} className="inline-flex items-center justify-center w-7 h-7 rounded transition-colors text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)" aria-label="Keyboard shortcuts">
            <QuestionIcon size={ICON_SIZE.SM} />
          </button>
          </WithTooltip>
          <WithTooltip label="Settings">
          <button onClick={onSettingsOpen} className={`inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${hasSystemPrompt || githubAuthenticated ? "text-(--color-accent) hover:text-(--color-accent-hover) hover:bg-(--color-bg-hover)" : "text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"}`} aria-label="Settings">
            <GearSixIcon size={ICON_SIZE.SM} />
          </button>
          </WithTooltip>
          <ThemePicker theme={theme} onSelectTheme={onSelectTheme} />
        </div>
      </header>

      {isMobile ? (
        <>
          {/* Relative wrapper so the sessions drawer overlays only the content
              region (above the tab bar), not the whole viewport. This keeps the
              MobileTabBar visible and interactive while the session list is open. */}
          <div className="relative flex flex-col flex-1 min-h-0">
            <div className="flex flex-col flex-1 min-h-0">
              {(showHomeScreen && !showNewSessionView) || mobilePanel === "chat" ? <div data-chat-panel className="flex flex-col flex-1 min-h-0">{chatPanel}</div> : <div className="flex flex-col flex-1 min-h-0 bg-(--color-bg-secondary)">{rightPanel}</div>}
            </div>
            {mobileSidebarOpen && (
              <div className="absolute inset-0 z-40 flex" role="dialog" aria-label="Sessions">
                {/* Backdrop — tap to close */}
                <button
                  type="button"
                  aria-label="Close sessions"
                  onClick={onCloseMobileSidebar}
                  className="absolute inset-0 bg-(--color-bg-overlay)"
                />
                {/* Drawer — full width on mobile. Dismissed by re-tapping the
                    header's Sessions toggle or by selecting a session; the
                    drawer covers the full width, so there's no backdrop gutter. */}
                <div className="relative flex h-full w-full bg-(--color-bg-primary) shadow-xl animate-in slide-in-from-left">
                  <SessionSidebar
                    sessions={sessions}
                    currentSessionId={currentSessionId}
                    activeNewSessionRepoUrl={activeNewSessionRepoUrl}
                    onResume={(sid) => { onResumeSession(sid); onCloseMobileSidebar(); }}
                    onArchive={onArchiveSession}
                    onNewSessionForRepo={(url) => { onNewSessionForRepo(url); onCloseMobileSidebar(); }}
                    collapsed={false}
                    onToggleCollapse={onCloseMobileSidebar}
                    repos={repos}
                    onAddRepo={() => { onAddRepo(); onCloseMobileSidebar(); }}
                    onCreateNewRepo={() => { onCreateNewRepo(); onCloseMobileSidebar(); }}
                    mobile
                    onClose={onCloseMobileSidebar}
                  />
                </div>
              </div>
            )}
          </div>
          {(!showHomeScreen || showNewSessionView) && (
            <MobileTabBar
              activePanel={mobilePanel}
              onChangePanel={onMobilePanelChange}
              onOpenSessions={onOpenSessions}
              onNewSession={onMobileNewSession}
              onQuickSession={onMobileQuickSession}
              onVoiceSession={onMobileVoiceSession}
              newSessionDisabled={repos.length === 0}
            />
          )}
        </>
      ) : (
        <div className="flex flex-1 min-h-0">
          <SessionSidebar
            sessions={sessions}
            currentSessionId={currentSessionId}
            activeNewSessionRepoUrl={activeNewSessionRepoUrl}
            onResume={onResumeSession}
            onArchive={onArchiveSession}
            onNewSessionForRepo={onNewSessionForRepo}
            collapsed={sidebarCollapsed}
            onToggleCollapse={onToggleSidebarCollapse}
            repos={repos}
            onAddRepo={onAddRepo}
            onCreateNewRepo={onCreateNewRepo}
          />
          <div ref={containerRef} className="flex flex-1 min-h-0 overflow-hidden">
            <div data-chat-panel className={`flex flex-col min-w-0 ${showHomeScreen ? "" : "border-r border-(--color-border-primary)"}`} style={{ width: showHomeScreen ? "100%" : `${fraction * 100}%` }}>
              {chatPanel}
            </div>
            {!showHomeScreen && (
              <>
                <ResizeHandle isDragging={isDragging} onMouseDown={onMouseDown} onTouchStart={onTouchStart} />
                <div className={`min-w-0 flex flex-col bg-(--color-bg-secondary) ${isDragging ? "pointer-events-none" : ""}`} style={{ width: `${(1 - fraction) * 100}%` }}>{rightPanel}</div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <Toast toast={toast} />}
      <QuickCaptureOverlay onAddRepo={onAddRepo} />
    </>
  );
}
