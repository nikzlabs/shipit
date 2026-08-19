import type { ReactNode } from "react";

/**
 * Which of the two mobile content trees is in front.
 *
 * Exported because `App` needs the same answer to tell the preview whether it is
 * on screen. Two copies of this rule would drift, and the copy that drifts
 * silently is the one that stops a hidden preview being told it is hidden —
 * which is how a background WebGL canvas keeps rendering (nikzlabs/shipit#2418).
 */
export function mobileChatInFront(state: {
  showHomeScreen: boolean;
  showNewSessionView: boolean;
  activePanel: "chat" | "preview";
}): boolean {
  return (state.showHomeScreen && !state.showNewSessionView) || state.activePanel === "chat";
}

interface MobileContentPanelsProps {
  showHomeScreen: boolean;
  showNewSessionView: boolean;
  activePanel: "chat" | "preview";
  chatPanel: ReactNode;
  rightPanel: ReactNode;
}

/**
 * Keeps both mobile content trees mounted while switching tabs. The chat tree
 * owns its scroll position and the workspace tree may contain a live preview
 * iframe, so unmounting either one turns a tab switch into a destructive reset.
 */
export function MobileContentPanels({
  showHomeScreen,
  showNewSessionView,
  activePanel,
  chatPanel,
  rightPanel,
}: MobileContentPanelsProps) {
  const showChat = mobileChatInFront({ showHomeScreen, showNewSessionView, activePanel });

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        data-chat-panel
        className={`${showChat ? "flex" : "hidden"} flex-col flex-1 min-h-0`}
        aria-hidden={!showChat}
      >
        {chatPanel}
      </div>
      <div
        className={`${showChat ? "hidden" : "flex"} flex-col flex-1 min-h-0 bg-(--color-bg-secondary)`}
        aria-hidden={showChat}
      >
        {rightPanel}
      </div>
    </div>
  );
}
