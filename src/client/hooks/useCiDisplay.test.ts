import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { deriveCiDisplay, useCiDisplay } from "./useCiDisplay.js";

const T0 = 1_800_000_000_000;

describe("deriveCiDisplay", () => {
  it("reports unknown when the poller hasn't spoken", () => {
    // Distinct from "none": callers gate the merge button on "none", and
    // treating silence as "no CI applies" would flash the button before the
    // first poll.
    expect(deriveCiDisplay(undefined, T0)).toEqual({ kind: "unknown" });
  });

  it("passes through success, failure, and genuine pending", () => {
    expect(
      deriveCiDisplay({ state: "success", total: 3, passed: 3, failed: 0, pending: 0 }, T0),
    ).toEqual({ kind: "success", total: 3 });
    expect(
      deriveCiDisplay({ state: "failure", total: 3, passed: 1, failed: 2, pending: 0 }, T0),
    ).toEqual({ kind: "failure", passed: 1, failed: 2, total: 3 });
    expect(
      deriveCiDisplay({ state: "pending", total: 3, passed: 1, failed: 0, pending: 2 }, T0),
    ).toEqual({ kind: "pending", passed: 1, total: 3 });
  });

  it("reports a server-settled empty check set as terminal", () => {
    expect(
      deriveCiDisplay({ state: "none", total: 0, passed: 0, failed: 0, pending: 0 }, T0),
    ).toEqual({ kind: "none" });
  });

  it("keeps the grace-forced pending inside its window", () => {
    const checks = {
      state: "pending" as const,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      graceUntil: T0 + 20_000,
    };
    expect(deriveCiDisplay(checks, T0)).toEqual({ kind: "pending", passed: 0, total: 0 });
    expect(deriveCiDisplay(checks, T0 + 19_999)).toEqual({ kind: "pending", passed: 0, total: 0 });
  });

  it("retires the grace-forced pending once its deadline passes", () => {
    // The core of nikzlabs/shipit#1730: polling can pause (last viewer
    // detached) while a forced-pending summary is the last word, so the
    // client must be able to expire it without a server round-trip.
    const checks = {
      state: "pending" as const,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      graceUntil: T0 + 20_000,
    };
    expect(deriveCiDisplay(checks, T0 + 20_000)).toEqual({ kind: "none" });
    expect(deriveCiDisplay(checks, T0 + 600_000)).toEqual({ kind: "none" });
  });

  it("never expires a pending state that has real checks behind it", () => {
    // A deadline should only ever ride along with an empty set; if one leaks
    // onto a summary with real checks, honor the checks.
    const checks = {
      state: "pending" as const,
      total: 2,
      passed: 1,
      failed: 0,
      pending: 1,
      graceUntil: T0 - 1,
    };
    expect(deriveCiDisplay(checks, T0)).toEqual({ kind: "pending", passed: 1, total: 2 });
  });

  it("leaves a pending state with no deadline alone (pre-graceUntil summaries)", () => {
    const checks = { state: "pending" as const, total: 0, passed: 0, failed: 0, pending: 0 };
    expect(deriveCiDisplay(checks, T0 + 600_000)).toEqual({ kind: "pending", passed: 0, total: 0 });
  });
});

describe("useCiDisplay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips to the terminal state on its own when the deadline elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const checks = {
      state: "pending" as const,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      graceUntil: T0 + 20_000,
    };

    const { result } = renderHook(() => useCiDisplay(checks));
    expect(result.current.kind).toBe("pending");

    act(() => {
      vi.advanceTimersByTime(21_000);
    });
    expect(result.current.kind).toBe("none");
  });

  it("schedules no timer when there is nothing to expire", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    renderHook(() =>
      useCiDisplay({ state: "success", total: 1, passed: 1, failed: 0, pending: 0 }),
    );
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
