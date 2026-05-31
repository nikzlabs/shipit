import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Helper: render the banner after a successful connection so banners become visible. */
function renderAfterConnect(
  props: Parameters<typeof ConnectionBanner>[0],
) {
  const result = render(<ConnectionBanner status="open" />);
  result.rerender(<ConnectionBanner {...props} />);
  return result;
}

describe("ConnectionBanner", () => {
  // --- Initial load: nothing visible ---

  it("renders nothing when status is open", () => {
    const { container } = render(<ConnectionBanner status="open" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on initial connecting (before ever connected)", () => {
    const { container } = render(<ConnectionBanner status="connecting" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing on initial closed (before ever connected)", () => {
    const { container } = render(<ConnectionBanner status="closed" />);
    expect(container.innerHTML).toBe("");
  });

  it("does NOT show 'Reconnected' on initial connecting → open (first load)", () => {
    const { rerender } = render(<ConnectionBanner status="connecting" />);
    rerender(<ConnectionBanner status="open" />);
    expect(screen.queryByText("Reconnected")).not.toBeInTheDocument();
  });

  // --- Grace period: banner hidden during delay ---

  it("does not show disconnect banner immediately after drop", () => {
    vi.useFakeTimers();
    const { rerender } = renderAfterConnect({ status: "closed" });
    // Before grace period fires, nothing visible
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender(<ConnectionBanner status="closed" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows disconnect banner after grace period", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "closed" });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument();
  });

  it("shows reconnecting banner after grace period", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "connecting" });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText("Reconnecting to server...")).toBeInTheDocument();
  });

  it("cancels disconnect banner if reconnected within grace period", () => {
    vi.useFakeTimers();
    const { rerender } = renderAfterConnect({ status: "closed" });
    // Reconnect before the grace period fires
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender(<ConnectionBanner status="open" />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // --- Styling ---

  it("uses yellow styling for connecting state", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "connecting" });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("warning");
  });

  it("uses red styling for closed state", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "closed" });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("error");
  });

  // --- Attempt count ---

  it("shows attempt number when reconnectAttempt > 1", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "closed", reconnectAttempt: 3 });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText(/attempt 3/)).toBeInTheDocument();
  });

  it("does not show attempt number on first attempt", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "closed", reconnectAttempt: 1 });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText(/attempt/)).not.toBeInTheDocument();
  });

  // --- Reconnect button ---

  it("renders Reconnect now button when closed and onReconnect provided", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "closed", onReconnect: vi.fn() });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText("Reconnect now")).toBeInTheDocument();
  });

  it("calls onReconnect when button is clicked", () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    renderAfterConnect({ status: "closed", onReconnect });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    fireEvent.click(screen.getByText("Reconnect now"));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("does not show Reconnect button when connecting", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "connecting" });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText("Reconnect now")).not.toBeInTheDocument();
  });

  it("does not show Reconnect button when onReconnect is not provided", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "closed" });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText("Reconnect now")).not.toBeInTheDocument();
  });

  // --- Reconnected flash ---

  it("shows 'Reconnected' when transitioning from closed to open", () => {
    vi.useFakeTimers();
    const { rerender } = renderAfterConnect({ status: "closed" });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    rerender(<ConnectionBanner status="open" />);
    expect(screen.getByText("Reconnected")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("hides 'Reconnected' banner after timeout", () => {
    vi.useFakeTimers();
    const { rerender } = renderAfterConnect({ status: "closed" });
    rerender(<ConnectionBanner status="open" />);
    expect(screen.getByText("Reconnected")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText("Reconnected")).not.toBeInTheDocument();
  });

  it("uses green styling for reconnected state", () => {
    const { rerender } = renderAfterConnect({ status: "closed" });
    rerender(<ConnectionBanner status="open" />);
    const banner = screen.getByRole("status");
    expect(banner.className).toContain("success");
  });

  // --- Compact mode (mobile) ---

  it("uses short copy and label in compact mode", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "closed", reconnectAttempt: 3, onReconnect: vi.fn(), compact: true });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // Short message without the "waiting to reconnect" verbiage.
    expect(screen.getByText("Connection lost (3)")).toBeInTheDocument();
    // Short button label so it fits a narrow screen.
    expect(screen.getByText("Reconnect")).toBeInTheDocument();
    expect(screen.queryByText("Reconnect now")).not.toBeInTheDocument();
  });

  it("shows compact connecting copy", () => {
    vi.useFakeTimers();
    renderAfterConnect({ status: "connecting", compact: true });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });
});
