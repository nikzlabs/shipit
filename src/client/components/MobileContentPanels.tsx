import type { ReactNode } from "react";

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
  const showChat = (showHomeScreen && !showNewSessionView) || activePanel === "chat";

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
