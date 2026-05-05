import type { ReactNode, RefObject } from "react";
import { GearSixIcon, ListIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "./design-tokens.js";
import { WithTooltip } from "./components/ui/tooltip.js";
import { ThemePicker } from "./components/ThemePicker.js";
import { SessionSidebar } from "./components/SessionSidebar.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { MobileTabBar } from "./components/MobileTabBar.js";
import { Toast } from "./components/Toast.js";
import type { WsStatus } from "./hooks/useWebSocket.js";
import { LIGHT_THEMES, type Theme } from "./hooks/useTheme.js";
import type { SessionInfo, RepoInfo, DockerMemoryStats } from "../server/shared/types.js";
import { DockerMemoryBadge } from "./components/DockerMemoryBadge.js";
import { MemoryPressureBanner } from "./components/MemoryPressureBanner.js";

interface AppLayoutProps {
  // Header
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
  onSettingsOpen: () => void;
  hasSystemPrompt: boolean;
  githubAuthenticated: boolean;
  dockerMemory: DockerMemoryStats | null;
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
  onDismissToast: () => void;
}

export function AppLayout({
  theme,
  onSelectTheme,
  onSettingsOpen,
  hasSystemPrompt,
  githubAuthenticated,
  dockerMemory,
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
  chatPanel,
  rightPanel,
  fraction,
  isDragging,
  onMouseDown,
  onTouchStart,
  containerRef,
  sessions,
  currentSessionId,
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
  onDismissToast,
}: AppLayoutProps) {
  return (
    <>
      <MemoryPressureBanner stats={dockerMemory} />
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
            <img src={LIGHT_THEMES.has(theme) ? "/favicon-light.svg" : "/favicon.svg"} alt="" className="w-5 h-5" />
            ShipIt
          </h1>
        </div>
        {showConnectionBanner && (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[60vw] pointer-events-none flex justify-center">
            <div className="pointer-events-auto">
              <ConnectionBanner status={connectionStatus} reconnectAttempt={reconnectAttempt} onReconnect={onReconnect} />
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {dockerMemory && <DockerMemoryBadge stats={dockerMemory} />}
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
          <div className="flex flex-col flex-1 min-h-0">
            {(showHomeScreen && !showNewSessionView) || mobilePanel === "chat" ? <div data-chat-panel className="flex flex-col flex-1 min-h-0">{chatPanel}</div> : <div className="flex flex-col flex-1 min-h-0 bg-(--color-bg-secondary)">{rightPanel}</div>}
          </div>
          {(!showHomeScreen || showNewSessionView) && <MobileTabBar activePanel={mobilePanel} onChangePanel={onMobilePanelChange} />}
          {mobileSidebarOpen && (
            <div className="fixed inset-0 z-40 flex" role="dialog" aria-label="Sessions">
              {/* Backdrop — tap to close */}
              <button
                type="button"
                aria-label="Close sessions"
                onClick={onCloseMobileSidebar}
                className="absolute inset-0 bg-(--color-bg-overlay)"
              />
              {/* Drawer — full width on phones */}
              <div className="relative flex h-full w-full max-w-sm bg-(--color-bg-primary) shadow-xl animate-in slide-in-from-left">
                <SessionSidebar
                  sessions={sessions}
                  currentSessionId={currentSessionId}
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
        </>
      ) : (
        <div className="flex flex-1 min-h-0">
          <SessionSidebar
            sessions={sessions}
            currentSessionId={currentSessionId}
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

      {toast && <Toast toast={toast} onDismiss={onDismissToast} />}
    </>
  );
}
