import type { ReactNode, RefObject } from "react";
import { GearSixIcon, RocketIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "./design-tokens.js";
import { ThemePicker } from "./components/ThemePicker.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { RepoSwitcher } from "./components/RepoSwitcher.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { MobileTabBar } from "./components/MobileTabBar.js";
import { Toast } from "./components/Toast.js";
import type { WsStatus } from "./hooks/useWebSocket.js";
import { LIGHT_THEMES, type Theme } from "./hooks/useTheme.js";
import type { SessionInfo, RepoInfo, DockerMemoryStats } from "../server/shared/types.js";
import { DockerMemoryBadge } from "./components/DockerMemoryBadge.js";

interface AppLayoutProps {
  // Header
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
  onDeployOpen: () => void;
  onSettingsOpen: () => void;
  hasSystemPrompt: boolean;
  githubAuthenticated: boolean;
  currentSessionUsage: { totalCostUsd: number } | null;
  dockerMemory: DockerMemoryStats | null;
  onUsageBadgeClick: () => void;
  onNavigateHome: () => void;

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
  activeRepoUrl: string | undefined;
  activeRepoName: string;
  activeRepoStatus?: "cloning" | "ready";
  currentSessionId: string | undefined;
  sidebarCollapsed: boolean;
  onResumeSession: (sid: string) => void;
  onArchiveSession: (sid: string) => Promise<void>;
  onOpenRepoSwitcher: () => void;
  onNewSession: () => void;
  onToggleSidebarCollapse: () => void;

  // Repo switcher
  repoSwitcherOpen: boolean;
  onCloseRepoSwitcher: () => void;
  repos: RepoInfo[];
  onSelectRepo: (url: string) => void;
  onAddRepo: () => void;
  onCreateNewRepo: () => void;

  // Toast
  toast: { message: string } | null;
  onDismissToast: () => void;
}

export function AppLayout({
  theme,
  onSelectTheme,
  onDeployOpen,
  onSettingsOpen,
  hasSystemPrompt,
  githubAuthenticated,
  currentSessionUsage,
  dockerMemory,
  onUsageBadgeClick,
  onNavigateHome,
  showConnectionBanner,
  connectionStatus,
  reconnectAttempt,
  onReconnect,
  isMobile,
  showHomeScreen,
  showNewSessionView,
  mobilePanel,
  onMobilePanelChange,
  chatPanel,
  rightPanel,
  fraction,
  isDragging,
  onMouseDown,
  onTouchStart,
  containerRef,
  sessions,
  activeRepoUrl,
  activeRepoName,
  activeRepoStatus,
  currentSessionId,
  sidebarCollapsed,
  onResumeSession,
  onArchiveSession,
  onOpenRepoSwitcher,
  onNewSession,
  onToggleSidebarCollapse,
  repoSwitcherOpen,
  onCloseRepoSwitcher,
  repos,
  onSelectRepo,
  onAddRepo,
  onCreateNewRepo,
  toast,
  onDismissToast,
}: AppLayoutProps) {
  return (
    <>
      <header className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-(--color-border-primary)">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <h1 className="text-lg font-semibold tracking-tight shrink-0 flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity" onClick={onNavigateHome} role="link">
            <img src={LIGHT_THEMES.has(theme) ? "/favicon-light.svg" : "/favicon.svg"} alt="" className="w-5 h-5" />
            ShipIt
          </h1>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {dockerMemory && <DockerMemoryBadge stats={dockerMemory} />}
          <button onClick={onDeployOpen} className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-(--color-accent-subtle) text-(--color-accent) hover:bg-(--color-accent) hover:text-(--color-accent-text) transition-colors font-medium" title="Deploy to production" aria-label="Deploy">
            <RocketIcon size={ICON_SIZE.SM} />
            Deploy
          </button>
          <button onClick={onSettingsOpen} className={`hidden sm:inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${hasSystemPrompt || githubAuthenticated ? "text-(--color-accent) hover:text-(--color-accent-hover) hover:bg-(--color-bg-hover)" : "text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"}`} title="Settings" aria-label="Settings">
            <GearSixIcon size={ICON_SIZE.SM} />
          </button>
          {currentSessionUsage && currentSessionUsage.totalCostUsd > 0 && (
            <button onClick={onUsageBadgeClick} className="hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-(--color-accent-subtle) text-(--color-accent) hover:bg-(--color-accent) hover:text-(--color-accent-text) transition-colors cursor-pointer" title="View usage details">
              {currentSessionUsage.totalCostUsd < 0.01 ? `$${currentSessionUsage.totalCostUsd.toFixed(3)}` : `$${currentSessionUsage.totalCostUsd.toFixed(2)}`}
            </button>
          )}
          <ThemePicker theme={theme} onSelectTheme={onSelectTheme} />
        </div>
      </header>

      {showConnectionBanner && <ConnectionBanner status={connectionStatus} reconnectAttempt={reconnectAttempt} onReconnect={onReconnect} />}

      {isMobile ? (
        <>
          <div className="flex flex-col flex-1 min-h-0">
            {(showHomeScreen && !showNewSessionView) || mobilePanel === "chat" ? <div className="flex flex-col flex-1 min-h-0">{chatPanel}</div> : <div className="flex flex-col flex-1 min-h-0 bg-(--color-bg-secondary)">{rightPanel}</div>}
          </div>
          {(!showHomeScreen || showNewSessionView) && <MobileTabBar activePanel={mobilePanel} onChangePanel={onMobilePanelChange} />}
        </>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="relative shrink-0">
            <SessionSidebar
              sessions={sessions}
              activeRepoUrl={activeRepoUrl}
              activeRepoName={activeRepoName}
              activeRepoStatus={activeRepoStatus}
              currentSessionId={currentSessionId}
              onResume={onResumeSession}
              onArchive={onArchiveSession}
              onOpenRepoSwitcher={onOpenRepoSwitcher}
              onNewSession={onNewSession}
              collapsed={sidebarCollapsed}
              onToggleCollapse={onToggleSidebarCollapse}
            />
            <RepoSwitcher
              open={repoSwitcherOpen}
              onClose={onCloseRepoSwitcher}
              repos={repos}
              activeRepoUrl={activeRepoUrl}
              onSelectRepo={onSelectRepo}
              onAddRepo={onAddRepo}
              onCreateNew={onCreateNewRepo}
            />
          </div>
          <div ref={containerRef} className="flex flex-1 min-h-0">
            <div className={`flex flex-col min-w-0 ${showHomeScreen ? "" : "border-r border-(--color-border-primary)"}`} style={{ width: showHomeScreen ? "100%" : `${fraction * 100}%` }}>
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

      {toast && <Toast toast={toast} onDismiss={onDismissToast} />}
    </>
  );
}
