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

  // The old copy said only what to configure. Stating the payoff is the reason
  // this state was rewritten, so it is not an incidental turn of phrase.
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

  // `dispatchAgentMessage` appends this text verbatim as a visible user bubble,
  // so it is part of the same first impression as the invite above it: it asks
  // for the outcome, and leaves the agent free to answer that there is none.
  describe("PREVIEW_SETUP_PROMPT", () => {
    it("asks for the outcome and allows the agent to answer that there is none", () => {
      expect(PREVIEW_SETUP_PROMPT).toMatch(/live preview/i);
      expect(PREVIEW_SETUP_PROMPT).toMatch(/say so instead of adding configuration/i);
    });
  });

  // The motion is decorative and index.css switches these classes off under
  // `prefers-reduced-motion`. That media query can't be asserted here, so pin
  // the hook instead: if a class is renamed on one side only, the illustration
  // keeps animating for users who asked it not to, silently.
  it("marks the animated parts with the classes index.css disables", () => {
    const { container } = render(<PreviewSetupInvite />);
    for (const cls of ["preview-art-float", "preview-art-dash", "preview-art-blink", "preview-art-sparkle"]) {
      expect(container.querySelector(`.${cls}`)).not.toBeNull();
    }
  });
});
