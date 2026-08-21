import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MobileContentPanels, mobileChatInFront } from "./MobileContentPanels.js";

afterEach(cleanup);

describe("MobileContentPanels", () => {
  it("keeps chat and workspace mounted while changing the active panel", () => {
    const { rerender } = render(
      <MobileContentPanels
        showHomeScreen={false}
        showNewSessionView={false}
        activePanel="chat"
        chatPanel={<div>Chat transcript</div>}
        rightPanel={<iframe title="Preview" />}
      />,
    );

    const chat = screen.getByText("Chat transcript");
    const preview = screen.getByTitle("Preview");
    const chatContainer = chat.parentElement;
    const previewContainer = preview.parentElement;

    expect(chatContainer).toHaveClass("flex");
    expect(previewContainer).toHaveClass("hidden");
    if (chatContainer) chatContainer.scrollTop = 240;

    rerender(
      <MobileContentPanels
        showHomeScreen={false}
        showNewSessionView={false}
        activePanel="preview"
        chatPanel={<div>Chat transcript</div>}
        rightPanel={<iframe title="Preview" />}
      />,
    );

    expect(screen.getByText("Chat transcript")).toBe(chat);
    expect(screen.getByTitle("Preview")).toBe(preview);
    expect(chatContainer).toHaveClass("hidden");
    expect(previewContainer).toHaveClass("flex");
    expect(chatContainer?.scrollTop).toBe(240);
  });

  it("keeps the home screen visible regardless of the remembered mobile panel", () => {
    render(
      <MobileContentPanels
        showHomeScreen
        showNewSessionView={false}
        activePanel="preview"
        chatPanel={<div>Home</div>}
        rightPanel={<div>Workspace</div>}
      />,
    );

    expect(screen.getByText("Home").parentElement).toHaveClass("flex");
    expect(screen.getByText("Workspace").parentElement).toHaveClass("hidden");
  });
});

describe("mobileChatInFront", () => {
  // One definition, used by the component here AND by App to decide whether the
  // preview pane is on screen. Pinned because a drift between the two would
  // leave a hidden preview rendering with nothing to show for it.
  const base = { showHomeScreen: false, showNewSessionView: false, activePanel: "preview" as const };

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
