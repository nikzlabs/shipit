import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MobileTabBar } from "./MobileTabBar.js";

afterEach(cleanup);

function renderMobileTabBar(
  props: Partial<ComponentProps<typeof MobileTabBar>> = {},
) {
  return render(
    <MobileTabBar
      activePanel="chat"
      sidebarOpen={false}
      onChangePanel={() => {}}
      onOpenSessions={() => {}}
      onNewSession={() => {}}
      onQuickSession={() => {}}
      onVoiceSession={() => {}}
      {...props}
    />,
  );
}

describe("MobileTabBar", () => {
  it("renders Chat and Workspace tabs", () => {
    renderMobileTabBar();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("renders thumb actions alongside the primary tabs", () => {
    renderMobileTabBar();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quick session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Voice quick session" })).toBeInTheDocument();
  });

  it("highlights the active Chat tab", () => {
    renderMobileTabBar({ activePanel: "chat" });
    const chatButton = screen.getByText("Chat").closest("button")!;
    expect(chatButton.className).toContain("text-(--color-text-link)");
    expect(chatButton).toHaveAttribute("aria-current", "page");

    const workspaceButton = screen.getByText("Workspace").closest("button")!;
    expect(workspaceButton.className).not.toContain("text-(--color-text-link)");
    expect(workspaceButton).not.toHaveAttribute("aria-current");
  });

  it("highlights the active Workspace tab", () => {
    renderMobileTabBar({ activePanel: "preview" });
    const workspaceButton = screen.getByText("Workspace").closest("button")!;
    expect(workspaceButton.className).toContain("text-(--color-text-link)");
    expect(workspaceButton).toHaveAttribute("aria-current", "page");

    const chatButton = screen.getByText("Chat").closest("button")!;
    expect(chatButton.className).not.toContain("text-(--color-text-link)");
  });

  it("highlights the Sessions tab and de-highlights content tabs when the sidebar is open", () => {
    renderMobileTabBar({ activePanel: "chat", sidebarOpen: true });

    const sessionsButton = screen.getByText("Sessions").closest("button")!;
    expect(sessionsButton.className).toContain("text-(--color-text-link)");
    expect(sessionsButton).toHaveAttribute("aria-current", "page");

    // Chat is the active panel underneath, but the open drawer owns the
    // active state — so Chat is not highlighted.
    const chatButton = screen.getByText("Chat").closest("button")!;
    expect(chatButton.className).not.toContain("text-(--color-text-link)");
    expect(chatButton).not.toHaveAttribute("aria-current");
  });

  it("calls onChangePanel with 'chat' when Chat is clicked", () => {
    const onChange = vi.fn();
    renderMobileTabBar({ activePanel: "preview", onChangePanel: onChange });
    fireEvent.click(screen.getByText("Chat"));
    expect(onChange).toHaveBeenCalledWith("chat");
  });

  it("calls onChangePanel with 'preview' when Workspace is clicked", () => {
    const onChange = vi.fn();
    renderMobileTabBar({ activePanel: "chat", onChangePanel: onChange });
    fireEvent.click(screen.getByText("Workspace"));
    expect(onChange).toHaveBeenCalledWith("preview");
  });

  it("calls action handlers from the center dock", () => {
    const onOpenSessions = vi.fn();
    const onNewSession = vi.fn();
    const onQuickSession = vi.fn();
    const onVoiceSession = vi.fn();
    renderMobileTabBar({ onOpenSessions, onNewSession, onQuickSession, onVoiceSession });

    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    fireEvent.click(screen.getByRole("button", { name: "Quick session" }));
    fireEvent.click(screen.getByRole("button", { name: "Voice quick session" }));

    expect(onOpenSessions).toHaveBeenCalledTimes(1);
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onQuickSession).toHaveBeenCalledTimes(1);
    expect(onVoiceSession).toHaveBeenCalledTimes(1);
  });

  it("disables new-session actions when there are no repos", () => {
    renderMobileTabBar({ newSessionDisabled: true });

    expect(screen.getByRole("button", { name: "New Session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quick session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Voice quick session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sessions" })).not.toBeDisabled();
  });

  it("has an accessible nav landmark", () => {
    renderMobileTabBar();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Mobile navigation")).toBeInTheDocument();
  });

  it("renders SVG icons inside buttons", () => {
    const { container } = renderMobileTabBar();
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(7);
  });
});
