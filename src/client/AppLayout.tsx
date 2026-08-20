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

/**
 * docs/150 — at which viewport width the header's status group (subscription
 * pills, uptime, memory) renders inline, and below which it collapses into the
 * gauge dropdown that already exists for mobile.
 *
 * The width it needs scales with the number of connected subscriptions: req 10
 * gives every account its own named pill, and an email-labelled pill is ~250px.
 * One always fits from `sm` — that layout is unchanged. Two or three do not,
 * and shrinking alone does not save them: past a point the label truncates to
 * nothing and the pills read as anonymous meters, which is req 10's account
 * name gone. Collapsing is the better failure — the dropdown stacks the same
 * pills vertically with their full labels, one click away.
 *
 * The whole group moves together rather than the pills alone, so a collapsed
 * width never renders uptime/memory both inline and in the dropdown.
 *
 * Thresholds are counted, not measured: a `ResizeObserver` would be exact, but
 * it buys precision at the boundary of a layout whose inputs (pill count, label
 * length) are already known here. Both class strings are spelled out in full
 * because Tailwind scans source text — a template-built class name would not be
 * generated.
 */
export function statusGroupBreakpoint(pillCount: number): {
  statusInline: string;
  statusCollapsed: string;
} {
  if (pillCount >= 3) return { statusInline: "hidden lg:contents", statusCollapsed: "lg:hidden" };
  if (pillCount === 2) return { statusInline: "hidden md:contents", statusCollapsed: "md:hidden" };
  return { statusInline: "hidden sm:contents", statusCollapsed: "sm:hidden" };
}

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
  /**
   * Called with the session the quick-capture overlay just created. Lets the
   * app graduate the URL when the overlay reused the /{slug}/new page's
   * claimed session (see App.tsx `handleQuickSessionCreated`). Background
   * sessions return a different id and don't trigger navigation.
   */
  onQuickSessionCreated: (session: SessionInfo) => void;
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
  // One number, two questions: how wide the status group is, and whether it has
  // anything in it at all. They were separate reads — the second was "any
  // connected account, or any snapshot" — and docs/274 req 16 made them
  // disagree: an xAI subscription is an account ShipIt can read no quota for,
  // so it renders no pill, and the old test opened a dropdown with nothing
  // subscription-shaped inside.
  const subscriptionPills = useSubscriptionPillCount(subscriptionLimits);
  const { statusInline, statusCollapsed } = statusGroupBreakpoint(subscriptionPills);

  return (
    <>
      <MemoryPressureBanner stats={dockerMemory} />
      <GitHubRateLimitBanner />
      <LocalModeBanner />
      <header className="relative flex items-center justify-between px-3 sm:px-6 py-2 sm:py-3 border-b border-(--color-border-primary)">
        {/* `shrink-0`, not `min-w-0`: this group holds only the logo, and
            `min-w-0` let it shrink to nothing while the `shrink-0` h1 inside
            overflowed — which is how the first subscription pill ended up
            rendered on top of the wordmark. Reserving the logo's own width is
            what makes the pills' shrinking above resolve against real space. */}
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <h1 className="text-base sm:text-lg font-semibold tracking-tight shrink-0">
            <a
              href="/"
              className="inline-flex hover:opacity-80 transition-opacity"
              onClick={(e) => {
                // Left-click (no modifier) stays in-app via client-side routing.
                // Middle-click / cmd+click / ctrl+click fall through to the
                // browser, which opens href="/" in a new background tab.
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
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[60vw] pointer-events-none flex justify-center">
            <div className="pointer-events-auto">
              <ConnectionBanner status={connectionStatus} reconnectAttempt={reconnectAttempt} onReconnect={onReconnect} />
            </div>
          </div>
        )}
        {/* `min-w-0`, not `shrink-0` (docs/150): with one connected subscription
            the pills always fit, but each additional account adds another
            ~250px pill — three email-labelled accounts overflowed this row at
            900px, sliding the first pill under the logo and pushing the
            settings icons off-screen entirely. Letting the group shrink hands
            the overflow to the pills, which truncate their labels; the trailing
            controls below keep `shrink-0` so they stay reachable. */}
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
          {/* Kept together in a `shrink-0` group so the pills above absorb every
              pixel of overflow before these do — they are navigation, not
              status, and a settings button pushed past the viewport edge has no
              recovery. */}
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
          {/* Relative wrapper so the sessions drawer overlays only the content
              region (above the tab bar), not the whole viewport. This keeps the
              MobileTabBar visible and interactive while the session list is open. */}
          <div className="relative flex flex-col flex-1 min-h-0">
            <MobileContentPanels
              showHomeScreen={showHomeScreen}
              showNewSessionView={showNewSessionView}
              activePanel={mobilePanel}
              chatPanel={chatPanel}
              rightPanel={rightPanel}
            />
            {/* Full-width drawer with no slide animation. It stays mounted while
                closed so list scroll and expanded navigation state are retained. */}
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
          {/* The tab bar is always present on mobile so the Sessions drawer — now
              home to the repo switcher and the advanced "+" menu — stays reachable
              everywhere, including the home screen. On the home screen there's no
              session to view, so the Chat/Workspace content tabs are disabled
              rather than the whole bar being hidden (which used to be a mobile-only
              special case). */}
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
