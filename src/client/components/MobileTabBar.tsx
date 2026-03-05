import { ChatCircleIcon, EyeIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

/**
 * MobileTabBar — bottom navigation bar shown only on mobile viewports.
 *
 * Provides a fixed-bottom tab bar with "Chat" and "Preview" tabs so users
 * can switch between the chat panel and the preview/docs panel when the
 * side-by-side layout isn't available.
 *
 * Design:
 *   - Fixed to the bottom of the screen
 *   - Two tabs: Chat (message icon) and Preview (eye icon)
 *   - Active tab gets a blue highlight; inactive tabs are muted gray
 *   - The tab bar includes a top border to separate from content
 */

export type MobilePanel = "chat" | "preview";

export function MobileTabBar({
  activePanel,
  onChangePanel,
}: {
  activePanel: MobilePanel;
  onChangePanel: (panel: MobilePanel) => void;
}) {
  return (
    <nav
      className="flex border-t border-(--color-border-primary) bg-(--color-bg-primary)"
      aria-label="Mobile navigation"
    >
      <button
        onClick={() => onChangePanel("chat")}
        className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-colors ${
          activePanel === "chat"
            ? "text-(--color-text-link)"
            : "text-(--color-text-secondary) active:text-(--color-text-primary)"
        }`}
        aria-current={activePanel === "chat" ? "page" : undefined}
      >
        {/* Chat icon (speech bubble) */}
        <ChatCircleIcon size={ICON_SIZE.MD} />
        Chat
      </button>

      <button
        onClick={() => onChangePanel("preview")}
        className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-colors ${
          activePanel === "preview"
            ? "text-(--color-text-link)"
            : "text-(--color-text-secondary) active:text-(--color-text-primary)"
        }`}
        aria-current={activePanel === "preview" ? "page" : undefined}
      >
        {/* Preview icon (eye) */}
        <EyeIcon size={ICON_SIZE.MD} />
        Preview
      </button>
    </nav>
  );
}
