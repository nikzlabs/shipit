import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useActivityTracker } from "./useActivityTracker.js";

describe("useActivityTracker", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let cleanup: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    cleanup?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount() {
    const result = renderHook(() => useActivityTracker());
    cleanup = result.unmount;
    return result;
  }

  function browserEvent(type: string) {
    return new window.Event(type);
  }

  it("sends an initial heartbeat on mount", () => {
    mount();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("/api/activity/heartbeat", { method: "POST" });
  });

  it("sends periodic heartbeats while user is active", () => {
    mount();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Simulate user activity
    window.dispatchEvent(browserEvent("mousemove"));

    // Advance to next heartbeat interval (15s)
    vi.advanceTimersByTime(15_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stops sending heartbeats when user is idle", () => {
    mount();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Don't trigger any activity — advance past idle timeout + heartbeat interval
    vi.advanceTimersByTime(45_000);

    // The interval fires at 15s (active → sends), 30s (active → sends), 45s (idle → skips)
    // Initial + 2 heartbeats = 3 total (30s idle timeout means 15s and 30s are still within window)
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Next interval at 60s — well past idle timeout, should skip
    vi.advanceTimersByTime(15_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("resumes heartbeats on user interaction after being idle", () => {
    mount();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Go idle
    vi.advanceTimersByTime(60_000);
    const countAfterIdle = fetchSpy.mock.calls.length;

    // User comes back — trigger activity
    window.dispatchEvent(browserEvent("keydown"));

    // Next heartbeat interval should fire
    vi.advanceTimersByTime(15_000);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(countAfterIdle);
  });

  it("sends heartbeat immediately when tab becomes visible", () => {
    mount();
    const countAfterMount = fetchSpy.mock.calls.length;

    // Simulate tab becoming visible
    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
    document.dispatchEvent(browserEvent("visibilitychange"));

    // Should have sent exactly one more heartbeat
    expect(fetchSpy.mock.calls.length).toBe(countAfterMount + 1);
  });

  it("cleans up listeners on unmount", () => {
    const { unmount } = mount();
    unmount();
    cleanup = () => {}; // already unmounted

    // Advance time — no more heartbeats should fire
    const countAfterUnmount = fetchSpy.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    expect(fetchSpy.mock.calls.length).toBe(countAfterUnmount);
  });
});
