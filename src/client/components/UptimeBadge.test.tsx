import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { UptimeBadge, formatUptime } from "./UptimeBadge.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatUptime", () => {
  it("renders sub-minute spans as 0m", () => {
    expect(formatUptime(0)).toBe("0m");
    expect(formatUptime(1_500)).toBe("0m");
    expect(formatUptime(59_000)).toBe("0m");
  });

  it("renders whole minutes", () => {
    expect(formatUptime(60_000)).toBe("1m");
    expect(formatUptime(3_599_000)).toBe("59m");
  });

  it("renders hour-plus spans with hours and minutes", () => {
    expect(formatUptime(3_600_000)).toBe("1h");
    expect(formatUptime(3_600_000 + 5 * 60_000)).toBe("1h 5m");
    expect(formatUptime(86_399_000)).toBe("23h 59m");
  });

  it("renders day-plus spans with days and hours", () => {
    expect(formatUptime(86_400_000)).toBe("1d");
    expect(formatUptime(3 * 86_400_000 + 5 * 3_600_000)).toBe("3d 5h");
  });

  it("clamps negative deltas (client/server clock skew) to zero", () => {
    expect(formatUptime(-5_000)).toBe("0m");
  });
});

describe("UptimeBadge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("renders the initial elapsed label from processStartedAt", () => {
    vi.setSystemTime(new Date("2026-05-18T12:02:30Z")); // 2m30s after start
    render(<UptimeBadge processStartedAt={new Date("2026-05-18T12:00:00Z").getTime()} />);
    expect(screen.getByText("2m")).toBeInTheDocument();
  });

  it("ticks the label as time advances", () => {
    vi.setSystemTime(new Date("2026-05-18T12:00:00Z"));
    render(<UptimeBadge processStartedAt={new Date("2026-05-18T12:00:00Z").getTime()} />);
    expect(screen.getByText("0m")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("1m")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(4 * 60_000); });
    expect(screen.getByText("5m")).toBeInTheDocument();
  });

  it("resets to a fresh elapsed when processStartedAt changes (post-restart)", () => {
    vi.setSystemTime(new Date("2026-05-18T12:05:00Z")); // 5min after first start
    const { rerender } = render(
      <UptimeBadge processStartedAt={new Date("2026-05-18T12:00:00Z").getTime()} />,
    );
    expect(screen.getByText("5m")).toBeInTheDocument();

    // Restart: orchestrator process bounced, SSE reconnected with a brand-new
    // start time matching "now". The badge should snap back to ~0.
    rerender(
      <UptimeBadge processStartedAt={new Date("2026-05-18T12:05:00Z").getTime()} />,
    );
    expect(screen.getByText("0m")).toBeInTheDocument();
  });
});
