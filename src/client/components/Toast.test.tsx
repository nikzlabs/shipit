import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { Toast } from "./Toast.js";
import type { ToastData } from "./Toast.js";

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
  it("renders the message", () => {
    render(<Toast toast={makeToast()} onDismiss={vi.fn()} />);
    expect(screen.getByText("Pushed to origin/my-branch")).toBeInTheDocument();
  });

  it("renders the action button when action is provided", () => {
    const onClick = vi.fn();
    render(
      <Toast
        toast={makeToast({ action: { label: "Create PR", onClick } })}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Create PR")).toBeInTheDocument();
  });

  it("does not render action button when no action provided", () => {
    render(<Toast toast={makeToast()} onDismiss={vi.fn()} />);
    expect(screen.queryByText("Create PR")).not.toBeInTheDocument();
  });

  it("calls action onClick and dismisses when action button is clicked", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={makeToast({ action: { label: "Create PR", onClick } })}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText("Create PR"));
    expect(onClick).toHaveBeenCalledOnce();
    // Wait for exit animation timeout
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("auto-dismisses after the specified duration", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast toast={makeToast({ duration: 8000 })} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    // Advance past the duration
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    // Wait for exit animation
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("uses default 8s duration when not specified", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast toast={makeToast({ duration: undefined })} onDismiss={onDismiss} />);
    // Should not dismiss before 8s
    act(() => {
      vi.advanceTimersByTime(7500);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    // Should dismiss after 8s + animation
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("dismisses when the close button is clicked", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast toast={makeToast()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("renders a checkmark icon", () => {
    render(<Toast toast={makeToast()} onDismiss={vi.fn()} />);
    const toast = screen.getByTestId("toast");
    expect(toast.textContent).toContain("✓");
  });
});
