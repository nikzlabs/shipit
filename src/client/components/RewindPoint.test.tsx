import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RewindPoint } from "./RewindPoint.js";

afterEach(cleanup);

function renderPoint(props: Partial<React.ComponentProps<typeof RewindPoint>> = {}) {
  return render(
    <RewindPoint
      gapPosition={2}
      defaultSessionName="Parent session"
      onRewind={vi.fn()}
      onRequestPreview={vi.fn()}
      {...props}
    />,
  );
}

describe("RewindPoint", () => {
  // planning#184: a running turn must not block fork. Fork spins off a new session

  it("keeps the fork affordance enabled while a turn is running", () => {
    renderPoint({ turnRunning: true });
    const button = screen.getByRole("button", { name: "Fork as new session" });
    expect(button).not.toBeDisabled();
  });

  it("offers the full rewind menu when idle", () => {
    renderPoint();
    expect(screen.getByRole("button", { name: "Rewind options" })).not.toBeDisabled();
  });

  // it must still fully gate the control and surface the wait tooltip).
  it("fully disables the control when disabled", () => {
    renderPoint({ disabled: true, turnRunning: true });
    const button = screen.getByRole("button", { name: "Fork as new session" });
    expect(button).toBeDisabled();
    expect(button.title).toBe("Wait for the current turn to finish");
  });

  // docs/007-threads-checkpoints reqs 6, 9 — the server says why the agent cannot rewind its
  // conversation in place, and the menu shows it on the disabled item, which names fork.
  it("disables a chat rewind the agent cannot make and shows why", () => {
    const reason = "Codex cannot rewind its conversation in place. Fork from here instead.";
    const onRewind = vi.fn();
    renderPoint({
      onRewind,
      previews: {
        chat: { type: "rewind_preview", gapPosition: 2, action: "chat", discardedTurnGroupCount: 1, unavailableReason: reason },
        both: { type: "rewind_preview", gapPosition: 2, action: "both", discardedTurnGroupCount: 1, fileCount: 1, unavailableReason: reason },
        code: { type: "rewind_preview", gapPosition: 2, action: "code", discardedTurnGroupCount: 1, fileCount: 1 },
      },
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Rewind options" }), { key: "Enter" });

    const chat = screen.getByRole("menuitem", { name: /Rewind chat to here/ });
    const both = screen.getByRole("menuitem", { name: /Rewind chat and code/ });
    expect(chat).toHaveAttribute("data-disabled");
    expect(both).toHaveAttribute("data-disabled");
    expect(chat).toHaveTextContent(reason);
    expect(screen.getByRole("menuitem", { name: /Rewind code to here/ })).not.toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: /Fork as new session/ })).not.toHaveAttribute("data-disabled");

    fireEvent.click(chat);
    expect(onRewind).not.toHaveBeenCalled();
  });

  it("labels the current-state handle as a current-state fork", () => {
    renderPoint({ currentState: true });
    expect(screen.getByRole("button", { name: "Fork current state" })).not.toBeDisabled();
  });
});
