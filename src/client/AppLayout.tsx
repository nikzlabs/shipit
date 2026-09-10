import type { ReactNode, RefObject } from "react";
import { GaugeIcon, GearSixIcon, QuestionIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "./design-tokens.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { WithTooltip } from "./components/ui/tooltip.js";
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
import { SubscriptionLimitsBadge, useSubscriptionPillCount } from "./components/SubscriptionLimitsBadge.js";
import { MobileStatusPanel } from "./components/MobileStatusPanel.js";
import { MemoryPressureBanner } from "./components/MemoryPressureBanner.js";
import { GitHubRateLimitBanner } from "./components/GitHubRateLimitBanner.js";
import { LocalModeBanner } from "./components/LocalModeBanner.js";
import { Logo } from "./components/Logo.js";
import { QuickCaptureOverlay } from "./components/QuickCaptureOverlay.js";
import { MobileContentPanels } from "./components/MobileContentPanels.js";
import { MobileSessionsPanel } from "./components/MobileSessionsPanel.js";

// Keep complete class names for Tailwind's source scanner.
export function statusGroupBreakpoint(pillCount: number): {
  statusInline: string;
  statusCollapsed: string;
} {
  if (pillCount >= 3) return { statusInline: "hidden lg:contents", statusCollapsed: "lg:hidden" };
  if (pillCount === 2) return { statusInline: "hidden md:contents", statusCollapsed: "md:hidden" };
  return { statusInline: "hidden sm:contents", statusCollapsed: "sm:hidden" };
}

interface AppLayoutProps {
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
  onSettingsOpen: () => void;
  onShortcutsOpen: () => void;
  hasSystemPrompt: boolean;
  githubAuthenticated: boolean;
  dockerMemory: DockerMemoryStats | null;
  /** Epoch milliseconds; null before the SSE handshake. */
  processStartedAt: number | null;
  subscriptionLimits: SubscriptionLimitsMap;
  onNavigateHome: () => void;
  onOpenSessions: () => void;

  showConnectionBanner: boolean;
  connectionStatus: WsStatus;
  reconnectAttempt: number;
  onReconnect: () => void;

  isMobile: boolean;
  showHomeScreen: boolean;
  showNewSessionView: boolean;
  mobilePanel: "chat" | "preview";
  onMobilePanelChange: (panel: "chat" | "preview") => void;
  onMobileNewSession: () => void;
  onMobileQuickSession: () => void;
  onMobileVoiceSession: () => void;
  onQuickSessionCreated: (session: SessionInfo) => void;
  chatPanel: ReactNode;
  rightPanel: ReactNode;

  fraction: number;
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  containerRef: RefObject<HTMLDivElement | null>;

  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  activeNewSessionRepoUrl: string | undefined;
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  onCloseMobileSidebar: () => void;
  onResumeSession: (sid: string) => void;
  onArchiveSession: (sid: string) => Promise<void>;
  onNewSessionForRepo: (repoUrl: string) => void;
  onToggleSidebarCollapse: () => void;

  repos: RepoInfo[];
  onAddRepo: () => void;
  onCreateNewRepo: () => void;

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
  onQuickSessionCreated,
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
  const subscriptionPills = useSubscriptionPillCount(subscriptionLimits);
  const { statusInline, statusCollapsed } = statusGroupBreakpoint(subscriptionPills);

  return (
    <>
      <MemoryPressureBanner stats={dockerMemory} />
      <GitHubRateLimitBanner />
      <LocalModeBanner />
      <header className="relative flex items-center justify-between px-3 sm:px-6 py-2 sm:py-3 border-b border-(--color-border-primary)">
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <h1 className="text-base sm:text-lg font-semibold tracking-tight shrink-0">
            <a
              href="/"
              className="inline-flex hover:opacity-80 transition-opacity"
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onNavigateHome();
              }}
            >
              <Logo />
            </a>
          </h1>
        </div>
        {showConnectionBanner && !isMobile && (
          <div className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 max-w-[60vw] pointer-events-none flex justify-center">
            <div className="pointer-events-auto">
              <ConnectionBanner status={connectionStatus} reconnectAttempt={reconnectAttempt} onReconnect={onReconnect} />
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className={statusInline}>
            <SubscriptionLimitsBadge limits={subscriptionLimits} />
            {processStartedAt !== null && <UptimeBadge processStartedAt={processStartedAt} />}
            {dockerMemory && <DockerMemoryBadge stats={dockerMemory} />}
          </div>
          {(processStartedAt !== null || dockerMemory !== null || subscriptionPills > 0) && (
            <div className={statusCollapsed}>
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
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
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
        </div>
      </header>

      {isMobile ? (
        <>
          <div className="relative flex flex-col flex-1 min-h-0">
            <MobileContentPanels
              showHomeScreen={showHomeScreen}
              showNewSessionView={showNewSessionView}
              activePanel={mobilePanel}
              chatPanel={chatPanel}
              rightPanel={rightPanel}
            />
            <MobileSessionsPanel open={mobileSidebarOpen} onClose={onCloseMobileSidebar}>
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
            </MobileSessionsPanel>
          </div>
          <MobileTabBar
            activePanel={mobilePanel}
            sidebarOpen={mobileSidebarOpen}
            contentTabsDisabled={showHomeScreen && !showNewSessionView}
            onChangePanel={onMobilePanelChange}
            onOpenSessions={onOpenSessions}
            onNewSession={onMobileNewSession}
            onQuickSession={onMobileQuickSession}
            onVoiceSession={onMobileVoiceSession}
            newSessionDisabled={repos.length === 0}
          />
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
      <QuickCaptureOverlay onAddRepo={onAddRepo} onSessionCreated={onQuickSessionCreated} />
    </>
  );
}
