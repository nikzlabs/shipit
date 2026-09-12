import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContentPanels, mobileChatInFront } from "./ContentPanels.js";

afterEach(cleanup);

const panels = (over: Partial<Parameters<typeof ContentPanels>[0]> = {}) => (
  <ContentPanels
    isMobile
    showHomeScreen={false}
    showNewSessionView={false}
    activePanel="chat"
    chatPanel={<div>Chat transcript</div>}
    rightPanel={<iframe title="Preview" />}
    fraction={0.5}
    isDragging={false}
    onMouseDown={() => {}}
    onTouchStart={() => {}}
    containerRef={createRef<HTMLDivElement>()}
    {...over}
  />
);

describe("ContentPanels", () => {
  it("keeps chat and workspace mounted while changing the active mobile panel", () => {
    const { rerender } = render(panels());

    const chat = screen.getByText("Chat transcript");
    const preview = screen.getByTitle("Preview");
    const chatContainer = chat.parentElement;
    const previewContainer = preview.parentElement;

    expect(chatContainer).toHaveClass("flex");
    expect(previewContainer).toHaveClass("hidden");
    if (chatContainer) chatContainer.scrollTop = 240;

    rerender(panels({ activePanel: "preview" }));

    expect(screen.getByText("Chat transcript")).toBe(chat);
    expect(screen.getByTitle("Preview")).toBe(preview);
    expect(chatContainer).toHaveClass("hidden");
    expect(previewContainer).toHaveClass("flex");
    expect(chatContainer?.scrollTop).toBe(240);
  });

  it("keeps the home screen visible regardless of the remembered mobile panel", () => {
    render(panels({ showHomeScreen: true, activePanel: "preview", rightPanel: <div>Workspace</div> }));

    expect(screen.getByText("Chat transcript").parentElement).toHaveClass("flex");
    expect(screen.getByText("Workspace").parentElement).toHaveClass("hidden");
  });

  it("keeps the chat column's DOM node across the mobile/desktop breakpoint", () => {
    const { rerender } = render(panels({ isMobile: false }));

    const chat = screen.getByText("Chat transcript");
    const chatContainer = chat.parentElement;
    if (chatContainer) chatContainer.scrollTop = 240;

    rerender(panels({ isMobile: true }));

    expect(screen.getByText("Chat transcript")).toBe(chat);
    expect(chatContainer?.scrollTop).toBe(240);
    // The mobile classes landed, so this is reuse and not a stale render.
    expect(chatContainer).toHaveClass("flex-1");
    expect(chatContainer?.style.width).toBe("");

    rerender(panels({ isMobile: false }));

    expect(screen.getByText("Chat transcript")).toBe(chat);
    expect(chatContainer?.scrollTop).toBe(240);
    expect(chatContainer?.style.width).toBe("50%");
  });

  it("releases the resize container ref on mobile", () => {
    // A drag in flight keeps reading the ref until the pointer is released;
    // `useResizablePanel` stops moving the split once it reads null. Holding the
    // ref on mobile would let a drag across the breakpoint rewrite the saved
    // split from the mobile container's rect.
    const containerRef = createRef<HTMLDivElement>();
    const { rerender } = render(panels({ isMobile: false, containerRef }));
    expect(containerRef.current).not.toBeNull();

    rerender(panels({ isMobile: true, containerRef }));
    expect(containerRef.current).toBeNull();

    rerender(panels({ isMobile: false, containerRef }));
    expect(containerRef.current).not.toBeNull();
  });

  it("shows the resize handle only on desktop, and only beside a workspace column", () => {
    const { rerender, container } = render(panels({ isMobile: false }));
    expect(container.querySelectorAll('.resize-handle').length).toBe(1);

    rerender(panels({ isMobile: true }));
    expect(container.querySelectorAll('.resize-handle').length).toBe(0);

    rerender(panels({ isMobile: false, showHomeScreen: true }));
    expect(container.querySelectorAll('.resize-handle').length).toBe(0);
    expect(screen.queryByTitle("Preview")).toBeNull();
  });
});

describe("mobileChatInFront", () => {
  // Also used by App to decide whether the preview pane is on screen; a drift
  // between the two leaves a hidden preview rendering.
  const base ={ showHomeScreen: false, showNewSessionView: false, activePanel: "preview" as const };

  it("puts the workspace in front when the preview panel is selected in a session", () => {
    expect(mobileChatInFront(base)).toBe(false);
  });

  it("puts chat in front when the chat panel is selected", () => {
    expect(mobileChatInFront({ ...base, activePanel: "chat" })).toBe(true);
  });

  it("puts chat in front on the home screen whatever the panel says", () => {
    expect(mobileChatInFront({ ...base, showHomeScreen: true })).toBe(true);
  });

  it("keeps the workspace reachable on the new-session route", () => {
    expect(mobileChatInFront({ ...base, showHomeScreen: true, showNewSessionView: true })).toBe(false);
  });
});
