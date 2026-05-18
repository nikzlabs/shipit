import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { UptimeBadge, formatUptime } from "./UptimeBadge.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatUptime", () => {
  it("formats sub-minute spans as seconds", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(1_500)).toBe("1s");
    expect(formatUptime(59_000)).toBe("59s");
  });

  it("formats sub-hour spans as minutes + seconds", () => {
    expect(formatUptime(60_000)).toBe("1m 0s");
    expect(formatUptime(3_599_000)).toBe("59m 59s");
  });

  it("formats sub-day spans as hours + minutes", () => {
    expect(formatUptime(3_600_000)).toBe("1h 0m");
    expect(formatUptime(86_399_000)).toBe("23h 59m");
  });

  it("formats day-plus spans as days + hours", () => {
    expect(formatUptime(86_400_000)).toBe("1d 0h");
    expect(formatUptime(3 * 86_400_000 + 5 * 3_600_000)).toBe("3d 5h");
  });

  it("clamps negative deltas (client/server clock skew) to zero", () => {
    expect(formatUptime(-5_000)).toBe("0s");
  });
});

describe("UptimeBadge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("renders the initial elapsed label from processStartedAt", () => {
    vi.setSystemTime(new Date("2026-05-18T12:00:30Z")); // 30s after start
    render(<UptimeBadge processStartedAt={new Date("2026-05-18T12:00:00Z").getTime()} />);
    expect(screen.getByText("30s")).toBeInTheDocument();
  });

  it("ticks the label every second as time advances", () => {
    vi.setSystemTime(new Date("2026-05-18T12:00:00Z"));
    render(<UptimeBadge processStartedAt={new Date("2026-05-18T12:00:00Z").getTime()} />);
    expect(screen.getByText("0s")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByText("5s")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(55_000); });
    expect(screen.getByText("1m 0s")).toBeInTheDocument();
  });

  it("resets to a fresh elapsed when processStartedAt changes (post-restart)", () => {
    vi.setSystemTime(new Date("2026-05-18T12:05:00Z")); // 5min after first start
    const { rerender } = render(
      <UptimeBadge processStartedAt={new Date("2026-05-18T12:00:00Z").getTime()} />,
    );
    expect(screen.getByText("5m 0s")).toBeInTheDocument();

    // Restart: orchestrator process bounced, SSE reconnected with a brand-new
    // start time matching "now". The badge should snap back to ~0.
    rerender(
      <UptimeBadge processStartedAt={new Date("2026-05-18T12:05:00Z").getTime()} />,
    );
    expect(screen.getByText("0s")).toBeInTheDocument();
  });
});
