import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "./dialog.js";

// history is mocked to no-ops so the back-dismiss machinery never mutates jsdom's
// real session history (which would dispatch async popstate events and bleed
// across tests). The only popstate events here are the ones we dispatch by hand.
beforeEach(() => {
  vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  vi.spyOn(window.history, "back").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Runs FIRST on purpose: at this point the module-level dismiss stack is empty,
// so the popstate assertions are deterministic.
describe("Dialog back-button dismissal", () => {
  it("closes the dialog when the browser Back button fires popstate", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Hi</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    // Opening pushes a dummy same-URL history entry so Back lands on the dialog
    // instead of navigating a route.
    expect(window.history.pushState).toHaveBeenCalled();

    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a single Back closes only the topmost of two stacked dialogs", () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    render(
      <>
        <Dialog open onOpenChange={onCloseA}>
          <DialogContent>
            <DialogTitle>A</DialogTitle>
          </DialogContent>
        </Dialog>
        <Dialog open onOpenChange={onCloseB}>
          <DialogContent>
            <DialogTitle>B</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );

    window.dispatchEvent(new PopStateEvent("popstate"));
    // B opened last → it's on top → it closes; A is untouched.
    expect(onCloseB).toHaveBeenCalledWith(false);
    expect(onCloseA).not.toHaveBeenCalled();
  });

  // The dummy-entry cleanup on a non-Back close must be conditional on the
  // dummy still being the TOP history entry. `history.state` carries the
  // `__shipitDialog` stamp only while our dummy is on top; after an in-dialog
  // navigation (e.g. "Create sandbox" → /session/{id}) the top entry is the
  // new route and history.back() would erase it — the "created a sandbox but
  // the UI stayed on the previous session" bug.
  describe("dummy-entry cleanup on non-Back close", () => {
    const setHistoryState = (value: unknown) => {
      Object.defineProperty(window.history, "state", { configurable: true, value });
    };
    afterEach(() => {
      // Remove the instance shadow so the prototype getter is restored.
      delete (window.history as unknown as Record<string, unknown>).state;
    });

    it("pops the dummy entry when it is still the top of the stack", () => {
      setHistoryState({ __shipitDialog: true });
      const { rerender } = render(
        <Dialog open onOpenChange={vi.fn()}>
          <DialogContent>
            <DialogTitle>Hi</DialogTitle>
          </DialogContent>
        </Dialog>,
      );
      rerender(
        <Dialog open={false} onOpenChange={vi.fn()}>
          <DialogContent>
            <DialogTitle>Hi</DialogTitle>
          </DialogContent>
        </Dialog>,
      );
      expect(window.history.back).toHaveBeenCalledTimes(1);
    });

    it("leaves history alone when a navigation replaced the top entry while open", () => {
      setHistoryState({ __shipitDialog: true });
      const { rerender } = render(
        <Dialog open onOpenChange={vi.fn()}>
          <DialogContent>
            <DialogTitle>Hi</DialogTitle>
          </DialogContent>
        </Dialog>,
      );
      // Simulate react-router pushing /session/{id} from the dialog's action
      // button: the top entry's state no longer carries the dialog stamp.
      setHistoryState({ usr: null, key: "abc123", idx: 2 });
      rerender(
        <Dialog open={false} onOpenChange={vi.fn()}>
          <DialogContent>
            <DialogTitle>Hi</DialogTitle>
          </DialogContent>
        </Dialog>,
      );
      expect(window.history.back).not.toHaveBeenCalled();
    });
  });
});

describe("DialogContent close button", () => {
  it("renders a default close button that fires onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Hi</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const close = screen.getByTestId("dialog-close");
    expect(close).toBeInTheDocument();
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
