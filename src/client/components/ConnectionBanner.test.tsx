import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner.js";

afterEach(cleanup);

describe("ConnectionBanner", () => {
  it("renders nothing when status is open", () => {
    const { container } = render(<ConnectionBanner status="open" />);
    expect(container.innerHTML).toBe("");
  });

  it("shows reconnecting message when status is connecting", () => {
    render(<ConnectionBanner status="connecting" />);
    expect(screen.getByText("Reconnecting to server...")).toBeInTheDocument();
  });

  it("shows connection lost message when status is closed", () => {
    render(<ConnectionBanner status="closed" />);
    expect(
      screen.getByText(/Connection lost — waiting to reconnect/)
    ).toBeInTheDocument();
  });

  it("has role=alert for accessibility when disconnected", () => {
    render(<ConnectionBanner status="closed" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("uses yellow styling for connecting state", () => {
    render(<ConnectionBanner status="connecting" />);
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("yellow");
  });

  it("uses red styling for closed state", () => {
    render(<ConnectionBanner status="closed" />);
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("red");
  });

  // --- New: attempt count ---
  it("shows attempt number when reconnectAttempt > 1", () => {
    render(<ConnectionBanner status="closed" reconnectAttempt={3} />);
    expect(screen.getByText(/attempt 3/)).toBeInTheDocument();
  });

  it("does not show attempt number on first attempt", () => {
    render(<ConnectionBanner status="closed" reconnectAttempt={1} />);
    expect(screen.queryByText(/attempt/)).not.toBeInTheDocument();
  });

  // --- New: reconnect button ---
  it("renders Reconnect now button when closed and onReconnect provided", () => {
    const onReconnect = vi.fn();
    render(<ConnectionBanner status="closed" onReconnect={onReconnect} />);
    expect(screen.getByText("Reconnect now")).toBeInTheDocument();
  });

  it("calls onReconnect when button is clicked", () => {
    const onReconnect = vi.fn();
    render(<ConnectionBanner status="closed" onReconnect={onReconnect} />);
    fireEvent.click(screen.getByText("Reconnect now"));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("does not show Reconnect button when connecting", () => {
    render(<ConnectionBanner status="connecting" onReconnect={vi.fn()} />);
    expect(screen.queryByText("Reconnect now")).not.toBeInTheDocument();
  });

  it("does not show Reconnect button when onReconnect is not provided", () => {
    render(<ConnectionBanner status="closed" />);
    expect(screen.queryByText("Reconnect now")).not.toBeInTheDocument();
  });

  // --- New: reconnected success feedback ---
  it("shows 'Reconnected' when transitioning from closed to open", () => {
    const { rerender } = render(<ConnectionBanner status="closed" />);
    rerender(<ConnectionBanner status="open" />);
    expect(screen.getByText("Reconnected")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows 'Reconnected' when transitioning from connecting to open", () => {
    const { rerender } = render(<ConnectionBanner status="connecting" />);
    rerender(<ConnectionBanner status="open" />);
    expect(screen.getByText("Reconnected")).toBeInTheDocument();
  });

  it("hides 'Reconnected' banner after timeout", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<ConnectionBanner status="closed" />);
    rerender(<ConnectionBanner status="open" />);

    expect(screen.getByText("Reconnected")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.queryByText("Reconnected")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("uses green styling for reconnected state", () => {
    const { rerender } = render(<ConnectionBanner status="closed" />);
    rerender(<ConnectionBanner status="open" />);
    const banner = screen.getByRole("status");
    expect(banner.className).toContain("green");
  });
});
