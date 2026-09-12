import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PreviewSetupInvite, PREVIEW_SETUP_PROMPT } from "./PreviewSetupInvite.js";

afterEach(cleanup);

describe("PreviewSetupInvite", () => {
  it("names both app kinds the user might have", () => {
    render(<PreviewSetupInvite />);
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("Android")).toBeInTheDocument();
  });

  it("states what the user gets, not just what to do", () => {
    render(<PreviewSetupInvite />);
    expect(screen.getByText(/runs in this panel while you build/)).toBeInTheDocument();
  });

  it("hides the decorative illustration from assistive tech", () => {
    render(<PreviewSetupInvite />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("calls back when the user asks the agent", () => {
    const onSendToAgent = vi.fn();
    render(<PreviewSetupInvite onSendToAgent={onSendToAgent} />);
    fireEvent.click(screen.getByText("Ask the agent to set it up"));
    expect(onSendToAgent).toHaveBeenCalled();
  });

  it("omits the button when there is nothing to call", () => {
    render(<PreviewSetupInvite />);
    expect(screen.queryByText("Ask the agent to set it up")).not.toBeInTheDocument();
  });

  describe("PREVIEW_SETUP_PROMPT", () => {
    it("asks for the outcome and allows the agent to answer that there is none", () => {
      expect(PREVIEW_SETUP_PROMPT).toMatch(/live preview/i);
      expect(PREVIEW_SETUP_PROMPT).toMatch(/say so instead of adding configuration/i);
    });
  });

  it("marks the animated parts with the classes index.css disables", () => {
    const { container } = render(<PreviewSetupInvite />);
    for (const cls of ["preview-art-float", "preview-art-dash", "preview-art-blink", "preview-art-sparkle"]) {
      expect(container.querySelector(`.${cls}`)).not.toBeNull();
    }
  });
});
