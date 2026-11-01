import type { ReactNode, RefObject } from "react";
import { ResizeHandle } from "./ResizeHandle.js";

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

/**
 * Whether the chat column shows the home screen, which on desktop also drops the
 * workspace column and every retained preview iframe in it.
 *
 * A session URL never shows it just because the store has no session yet. The
 * URL and the store do not change in one commit: React Router renders a
 * navigation as a transition, after the store writes beside it, and Back is a
 * popstate the store follows from an effect. One such commit on the way to
 * `/{slug}/new` was enough to reload the preview
 * (docs/089-persistent-preview-iframes).
 */
export function homeScreenShown(state: {
  showNewSessionView: boolean;
  urlSessionId: string | undefined;
  sessionId: string | undefined;
  templatesForEmptySession: boolean;
}): boolean {
  if (state.showNewSessionView) return false;
  return (!state.sessionId && !state.urlSessionId) || state.templatesForEmptySession;
}

interface ContentPanelsProps {
  isMobile: boolean;
  showHomeScreen: boolean;
  showNewSessionView: boolean;
  activePanel: "chat" | "preview";
  chatPanel: ReactNode;
  rightPanel: ReactNode;
  fraction: number;
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  containerRef: RefObject<HTMLDivElement | null>;
}

/**
 * The chat and workspace columns, in one tree that serves both layouts.
 *
 * Two invariants, both about not destroying state the user can see.
 *
 * Mobile keeps both columns mounted and hides one by class: the chat column owns
 * its scroll position and the workspace column may hold a live preview iframe,
 * so unmounting either makes a tab switch destructive.
 *
 * React reconciles by element type and child position, so neither may depend on
 * `isMobile`: a divergence remounts the whole chat column on every resize, zoom
 * or rotation across 768 px. `isMobile` may choose classes, styles and whether a
 * child renders — an unrendered child leaves its slot occupied by `null`, which
 * holds the positions of its siblings. Same rule for `AppLayout`'s wrapper around
 * this; `AppLayout.test.tsx` guards the pair.
 */
export function ContentPanels({
  isMobile,
  showHomeScreen,
  showNewSessionView,
  activePanel,
  chatPanel,
  rightPanel,
  fraction,
  isDragging,
  onMouseDown,
  onTouchStart,
  containerRef,
}: ContentPanelsProps) {
  const showChat = mobileChatInFront({ showHomeScreen, showNewSessionView, activePanel });
  // Desktop drops the workspace column on the home screen; mobile keeps it
  // mounted so its tab switch stays non-destructive.
  const showRight = isMobile || !showHomeScreen;

  return (
    <div
      // Desktop only: an in-flight drag reads this rect until release, and
      // `useResizablePanel` treats a null ref as "no longer resizable" — which is
      // how a drag that crosses the breakpoint stops moving the split.
      ref={isMobile ? null : containerRef}
      className={isMobile ? "flex flex-col flex-1 min-h-0" : "flex flex-1 min-h-0 overflow-hidden"}
    >
      <div
        data-chat-panel
        className={
          isMobile
            ? `${showChat ? "flex" : "hidden"} flex-col flex-1 min-h-0`
            : `flex flex-col min-w-0 ${showHomeScreen ? "" : "border-r border-(--color-border-primary)"}`
        }
        style={isMobile ? undefined : { width: showHomeScreen ? "100%" : `${fraction * 100}%` }}
        aria-hidden={isMobile ? !showChat : undefined}
      >
        {chatPanel}
      </div>
      {!isMobile && !showHomeScreen && (
        <ResizeHandle isDragging={isDragging} onMouseDown={onMouseDown} onTouchStart={onTouchStart} />
      )}
      {showRight && (
        <div
          className={
            isMobile
              ? `${showChat ? "hidden" : "flex"} flex-col flex-1 min-h-0 bg-(--color-bg-secondary)`
              : `min-w-0 flex flex-col bg-(--color-bg-secondary) ${isDragging ? "pointer-events-none" : ""}`
          }
          style={isMobile ? undefined : { width: `${(1 - fraction) * 100}%` }}
          aria-hidden={isMobile ? showChat : undefined}
        >
          {rightPanel}
        </div>
      )}
    </div>
  );
}
