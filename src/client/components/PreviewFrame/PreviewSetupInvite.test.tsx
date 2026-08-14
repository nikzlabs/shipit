import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PreviewSetupInvite } from "./PreviewSetupInvite.js";

afterEach(cleanup);

describe("PreviewSetupInvite", () => {
  it("names both app kinds the user might have", () => {
    render(<PreviewSetupInvite />);
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("Android")).toBeInTheDocument();
  });

  it("describes the illustration for screen readers", () => {
    render(<PreviewSetupInvite />);
    expect(screen.getByRole("img")).toHaveAccessibleName(/browser window and an empty phone/i);
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
