import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { Toast } from "./Toast.js";
import type { ToastData } from "./Toast.js";
import { useUiStore } from "../stores/ui-store.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeToast(overrides: Partial<ToastData> = {}): ToastData {
  return {
    message: "Pushed to origin/my-branch",
    duration: 8000,
    ...overrides,
  };
}

describe("Toast", () => {
  beforeEach(() => {
    useUiStore.getState().setToast(null);
  });

  it("renders the message", () => {
    render(<Toast toast={makeToast()} />);
    expect(screen.getByText("Pushed to origin/my-branch")).toBeInTheDocument();
  });

  it("renders the action button when action is provided", () => {
    const onClick = vi.fn();
    render(<Toast toast={makeToast({ action: { label: "Create PR", onClick } })} />);
    expect(screen.getByText("Create PR")).toBeInTheDocument();
  });

  it("does not render action button when no action provided", () => {
    render(<Toast toast={makeToast()} />);
    expect(screen.queryByText("Create PR")).not.toBeInTheDocument();
  });

  it("calls action onClick and clears the store toast when action is clicked", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    useUiStore.getState().setToast(makeToast({ action: { label: "Create PR", onClick } }));
    render(<Toast toast={useUiStore.getState().toast!} />);
    fireEvent.click(screen.getByText("Create PR"));
    expect(onClick).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("auto-dismisses after the specified duration", () => {
    vi.useFakeTimers();
    useUiStore.getState().setToast(makeToast({ duration: 8000 }));
    render(<Toast toast={useUiStore.getState().toast!} />);
    expect(useUiStore.getState().toast).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("uses default 8s duration when not specified", () => {
    vi.useFakeTimers();
    useUiStore.getState().setToast(makeToast({ duration: undefined }));
    render(<Toast toast={useUiStore.getState().toast!} />);
    act(() => {
      vi.advanceTimersByTime(7500);
    });
    expect(useUiStore.getState().toast).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("dismisses when the close button is clicked", () => {
    vi.useFakeTimers();
    useUiStore.getState().setToast(makeToast());
    render(<Toast toast={useUiStore.getState().toast!} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("renders a checkmark icon", () => {
    render(<Toast toast={makeToast()} />);
    const toast = screen.getByTestId("toast");
    expect(toast.querySelector("svg")).toBeInTheDocument();
  });
});
