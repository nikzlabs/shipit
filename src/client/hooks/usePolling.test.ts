import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { usePolling } from "./usePolling.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Flush the microtask queue so a resolved poll's `.then` continuations
// (setData/setError) run inside React's act() before we assert.
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

describe("usePolling", () => {
  it("polls immediately and then on every interval", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue("v");
    renderHook(() => usePolling({ poll, intervalMs: 1000 }));

    await flush();
    expect(poll).toHaveBeenCalledTimes(1); // immediate first poll

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(poll).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("skips the leading poll when immediate is false", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue("v");
    renderHook(() => usePolling({ poll, intervalMs: 1000, immediate: false }));

    await flush();
    expect(poll).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("exposes data on success", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(() => usePolling({ poll, intervalMs: 1000 }));

    await flush();
    expect(result.current.data).toEqual({ ok: true });
    expect(result.current.error).toBeNull();
  });

  it("captures the error message and invokes onError", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const poll = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePolling({ poll, intervalMs: 1000, onError }));

    await flush();
    expect(result.current.error).toBe("boom");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBeNull();
  });

  it("runs onSuccess with the fresh value after a poll", async () => {
    vi.useFakeTimers();
    const onSuccess = vi.fn();
    const poll = vi.fn().mockResolvedValue(42);
    renderHook(() => usePolling({ poll, intervalMs: 1000, onSuccess }));

    await flush();
    expect(onSuccess).toHaveBeenCalledWith(42);
  });

  it("does not poll when disabled", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue("v");
    renderHook(() => usePolling({ poll, intervalMs: 1000, enabled: false }));

    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(poll).not.toHaveBeenCalled();
  });

  it("stops polling when enabled flips to false", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue("v");
    const { rerender } = renderHook(
      (props: { enabled: boolean }) => usePolling({ poll, intervalMs: 1000, enabled: props.enabled }),
      { initialProps: { enabled: true } },
    );

    await flush();
    expect(poll).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(poll).toHaveBeenCalledTimes(1); // no further polls after disable
  });

  it("clears data when disabled if resetOnDisable is set", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue("v");
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        usePolling({ poll, intervalMs: 1000, enabled: props.enabled, resetOnDisable: true }),
      { initialProps: { enabled: true } },
    );

    await flush();
    expect(result.current.data).toBe("v");

    rerender({ enabled: false });
    await flush();
    expect(result.current.data).toBeNull();
  });

  it("drops a stale in-flight response after the loop is torn down", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (v: string) => void;
    // First (immediate) poll hangs until we resolve it by hand.
    const poll = vi.fn(() => new Promise<string>((resolve) => { resolveFirst = resolve; }));
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) => usePolling({ poll, intervalMs: 1000, enabled: props.enabled }),
      { initialProps: { enabled: true } },
    );

    // Disable before the in-flight poll resolves — cleanup bumps the epoch.
    rerender({ enabled: false });

    // Now let the stale poll resolve; its write must be dropped.
    await act(async () => {
      resolveFirst("stale");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.data).toBeNull();
  });

  it("clears the interval on unmount (no polls fire afterward)", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue("v");
    const { unmount } = renderHook(() => usePolling({ poll, intervalMs: 1000 }));

    await flush();
    expect(poll).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("refresh() triggers an immediate off-cycle poll", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue("v");
    const { result } = renderHook(() => usePolling({ poll, intervalMs: 10_000 }));

    await flush();
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.refresh(); });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("re-arms the interval when intervalMs changes", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue("v");
    const { rerender } = renderHook(
      (props: { ms: number }) => usePolling({ poll, intervalMs: props.ms, immediate: false }),
      { initialProps: { ms: 1000 } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(poll).toHaveBeenCalledTimes(1);

    rerender({ ms: 200 }); // faster cadence
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(poll).toHaveBeenCalledTimes(4); // 3 more at 200ms
  });
});
