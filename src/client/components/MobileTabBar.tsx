import { ChatCircleIcon, LightningIcon, ListIcon, MicrophoneIcon, PlusIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { WithTooltip } from "./ui/tooltip.js";

/**
 * MobileTabBar — bottom navigation bar shown only on mobile viewports.
 *
 * Provides a fixed-bottom tab bar with "Chat" and "Workspace" tabs so users
 * can switch between the chat panel and the multi-tab workspace panel
 * (preview, docs, files, terminal, etc.) when the side-by-side layout
 * isn't available.
 *
 * Design:
 *   - Fixed to the bottom of the screen
 *   - Two tabs: Chat (speech bubble) and Workspace (four-squares icon)
 *   - Active tab gets a blue highlight; inactive tabs are muted gray
 *   - The tab bar includes a top border to separate from content
 */

export type MobilePanel = "chat" | "preview";

export function MobileTabBar({
  activePanel,
  onChangePanel,
  onOpenSessions,
  onNewSession,
  onQuickSession,
  onVoiceSession,
  newSessionDisabled = false,
}: {
  activePanel: MobilePanel;
  onChangePanel: (panel: MobilePanel) => void;
  onOpenSessions: () => void;
  onNewSession: () => void;
  onQuickSession: () => void;
  onVoiceSession: () => void;
  newSessionDisabled?: boolean;
}) {
  return (
    <nav
      className="grid grid-cols-[minmax(8rem,1fr)_auto] items-center gap-3 border-t border-(--color-border-primary) bg-(--color-bg-primary) px-3 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]"
      aria-label="Mobile navigation"
    >
      <div className="grid min-w-0 grid-cols-2 gap-1">
        <button
          onClick={() => onChangePanel("chat")}
          className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md text-xs font-medium transition-colors ${
            activePanel === "chat"
              ? "text-(--color-text-link)"
              : "text-(--color-text-secondary) active:bg-(--color-bg-hover) active:text-(--color-text-primary)"
          }`}
          aria-current={activePanel === "chat" ? "page" : undefined}
        >
          <ChatCircleIcon size={ICON_SIZE.MD} />
          Chat
        </button>

        <button
          onClick={() => onChangePanel("preview")}
          className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md text-xs font-medium transition-colors ${
            activePanel === "preview"
              ? "text-(--color-text-link)"
              : "text-(--color-text-secondary) active:bg-(--color-bg-hover) active:text-(--color-text-primary)"
          }`}
          aria-current={activePanel === "preview" ? "page" : undefined}
        >
          <SquaresFourIcon size={ICON_SIZE.MD} />
          Workspace
        </button>
      </div>

      <div className="flex items-center justify-center gap-1 border-l border-(--color-border-primary) pl-3">
        <WithTooltip label="Sessions" side="top">
          <button
            type="button"
            onClick={onOpenSessions}
            className="inline-flex h-10 w-9 items-center justify-center rounded-md text-(--color-text-secondary) transition-colors active:bg-(--color-bg-hover) active:text-(--color-text-primary)"
            aria-label="Sessions"
          >
            <ListIcon size={ICON_SIZE.MD} />
          </button>
        </WithTooltip>
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
