import { ChatCircleIcon, LightningIcon, ListIcon, MicrophoneIcon, PlusIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { WithTooltip } from "./ui/tooltip.js";

/**
 * MobileTabBar — bottom navigation bar shown only on mobile viewports.
 *
 * The left group is a 3-way segmented control — Chat, Workspace, and Sessions
 * — where exactly one is active at a time. Chat/Workspace swap the main content
 * panel; Sessions opens the session-list drawer. Because they're mutually
 * exclusive states (not independent toggles), tapping the already-active
 * Sessions tab is a no-op — the drawer is dismissed by switching to Chat or
 * Workspace (or by picking a session). The right group holds the
 * session-creation actions (New, Quick, Voice).
 *
 * Design:
 *   - Fixed to the bottom of the screen
 *   - Active tab gets a blue highlight; inactive tabs are muted gray
 *   - The tab bar includes a top border to separate from content
 */

export type MobilePanel = "chat" | "preview";

const TAB_BASE =
  "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md text-xs font-medium transition-colors";
const TAB_INACTIVE =
  "text-(--color-text-secondary) active:bg-(--color-bg-hover) active:text-(--color-text-primary)";
const TAB_ACTIVE = "text-(--color-text-link)";

export function MobileTabBar({
  activePanel,
  sidebarOpen,
  onChangePanel,
  onOpenSessions,
  onNewSession,
  onQuickSession,
  onVoiceSession,
  newSessionDisabled = false,
}: {
  activePanel: MobilePanel;
  sidebarOpen: boolean;
  onChangePanel: (panel: MobilePanel) => void;
  onOpenSessions: () => void;
  onNewSession: () => void;
  onQuickSession: () => void;
  onVoiceSession: () => void;
  newSessionDisabled?: boolean;
}) {
  // The drawer, when open, owns the active state — so neither content tab is
  // highlighted while Sessions is selected.
  const chatActive = !sidebarOpen && activePanel === "chat";
  const workspaceActive = !sidebarOpen && activePanel === "preview";
  return (
    <nav
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-(--color-border-primary) bg-(--color-bg-primary) px-3 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]"
      aria-label="Mobile navigation"
    >
      <div className="grid min-w-0 grid-cols-3 gap-1">
        <button
          onClick={() => onChangePanel("chat")}
          className={`${TAB_BASE} ${chatActive ? TAB_ACTIVE : TAB_INACTIVE}`}
          aria-current={chatActive ? "page" : undefined}
        >
          <ChatCircleIcon size={ICON_SIZE.MD} />
          Chat
        </button>

        <button
          onClick={() => onChangePanel("preview")}
          className={`${TAB_BASE} ${workspaceActive ? TAB_ACTIVE : TAB_INACTIVE}`}
          aria-current={workspaceActive ? "page" : undefined}
        >
          <SquaresFourIcon size={ICON_SIZE.MD} />
          Workspace
        </button>

        <button
          onClick={onOpenSessions}
          className={`${TAB_BASE} ${sidebarOpen ? TAB_ACTIVE : TAB_INACTIVE}`}
          aria-current={sidebarOpen ? "page" : undefined}
        >
          <ListIcon size={ICON_SIZE.MD} />
          Sessions
        </button>
      </div>

      <div className="flex items-center justify-center gap-1 border-l border-(--color-border-primary) pl-3">
        <WithTooltip label="New Session" side="top">
          <button
            type="button"
            onClick={onNewSession}
            disabled={newSessionDisabled}
            className="inline-flex h-10 w-9 items-center justify-center rounded-md text-(--color-text-secondary) transition-colors active:bg-(--color-bg-hover) active:text-(--color-text-primary) disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="New Session"
          >
            <PlusIcon size={ICON_SIZE.MD} weight="bold" />
          </button>
        </WithTooltip>
        <WithTooltip label="Quick session" side="top">
          <button
            type="button"
            onClick={onQuickSession}
            disabled={newSessionDisabled}
            className="inline-flex h-10 w-9 items-center justify-center rounded-md text-(--color-text-secondary) transition-colors active:bg-(--color-bg-hover) active:text-(--color-text-primary) disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Quick session"
          >
            <LightningIcon size={ICON_SIZE.MD} />
          </button>
        </WithTooltip>
        <WithTooltip label="Voice quick session" side="top">
          <button
            type="button"
            onClick={onVoiceSession}
            disabled={newSessionDisabled}
            className="inline-flex h-10 w-9 items-center justify-center rounded-md text-(--color-text-secondary) transition-colors active:bg-(--color-bg-hover) active:text-(--color-text-primary) disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Voice quick session"
          >
            <span className="relative inline-flex h-5 w-5 items-center justify-center">
              <LightningIcon size={ICON_SIZE.MD} />
              <MicrophoneIcon
                size={ICON_SIZE.XS}
                weight="fill"
                className="absolute -bottom-0.5 -right-1 rounded-full bg-(--color-bg-primary)"
              />
            </span>
          </button>
        </WithTooltip>
      </div>
    </nav>
  );
}
