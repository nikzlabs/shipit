import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MobileTabBar } from "./MobileTabBar.js";

afterEach(cleanup);

describe("MobileTabBar", () => {
  it("renders Chat and Preview tabs", () => {
    render(<MobileTabBar activePanel="chat" onChangePanel={() => {}} />);
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("highlights the active Chat tab", () => {
    render(<MobileTabBar activePanel="chat" onChangePanel={() => {}} />);
    const chatButton = screen.getByText("Chat").closest("button")!;
    expect(chatButton.className).toContain("text-(--color-text-link)");
    expect(chatButton).toHaveAttribute("aria-current", "page");

    const previewButton = screen.getByText("Preview").closest("button")!;
    expect(previewButton.className).not.toContain("text-(--color-text-link)");
    expect(previewButton).not.toHaveAttribute("aria-current");
  });

  it("highlights the active Preview tab", () => {
    render(<MobileTabBar activePanel="preview" onChangePanel={() => {}} />);
    const previewButton = screen.getByText("Preview").closest("button")!;
    expect(previewButton.className).toContain("text-(--color-text-link)");
    expect(previewButton).toHaveAttribute("aria-current", "page");

    const chatButton = screen.getByText("Chat").closest("button")!;
    expect(chatButton.className).not.toContain("text-(--color-text-link)");
  });

  it("calls onChangePanel with 'chat' when Chat is clicked", () => {
    const onChange = vi.fn();
    render(<MobileTabBar activePanel="preview" onChangePanel={onChange} />);
    fireEvent.click(screen.getByText("Chat"));
    expect(onChange).toHaveBeenCalledWith("chat");
  });

  it("calls onChangePanel with 'preview' when Preview is clicked", () => {
    const onChange = vi.fn();
    render(<MobileTabBar activePanel="chat" onChangePanel={onChange} />);
    fireEvent.click(screen.getByText("Preview"));
    expect(onChange).toHaveBeenCalledWith("preview");
  });

  it("has an accessible nav landmark", () => {
    render(<MobileTabBar activePanel="chat" onChangePanel={() => {}} />);
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Mobile navigation")).toBeInTheDocument();
  });

  it("renders SVG icons inside buttons", () => {
    const { container } = render(
      <MobileTabBar activePanel="chat" onChangePanel={() => {}} />
    );
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(2);
  });
});
