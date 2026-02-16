import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { usePreviewErrors } from "./usePreviewErrors.js";

afterEach(cleanup);

function postPreviewError(overrides: Record<string, unknown> = {}) {
  window.postMessage(
    {
      source: "shipit-preview",
      type: "error",
      message: "Uncaught TypeError: x is not a function",
      ...overrides,
    },
    "*",
  );
}

function postConsoleError(args: string[], level: "error" | "warn" = "error") {
  window.postMessage(
    { source: "shipit-preview", type: "console", level, args },
    "*",
  );
}

// postMessage is async — we need to flush the event loop
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("usePreviewErrors", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with an empty error list", () => {
    const { result } = renderHook(() => usePreviewErrors());
    expect(result.current.errors).toEqual([]);
    expect(result.current.hasErrors).toBe(false);
    expect(result.current.errorCount).toBe(0);
  });

  it("captures window.onerror postMessages", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      postPreviewError({ message: "Test error" });
      await flush();
    });

    expect(result.current.errors).toHaveLength(1);
    expect(result.current.errors[0].message).toBe("Test error");
    expect(result.current.errors[0].type).toBe("error");
    expect(result.current.hasErrors).toBe(true);
    expect(result.current.errorCount).toBe(1);
  });

  it("captures console.error postMessages", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      postConsoleError(["Error:", "something failed"]);
      await flush();
    });

    expect(result.current.errors).toHaveLength(1);
    expect(result.current.errors[0].type).toBe("console");
    expect(result.current.errors[0].level).toBe("error");
    expect(result.current.errors[0].message).toBe("Error: something failed");
  });

  it("captures console.warn postMessages", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      postConsoleError(["Deprecation warning"], "warn");
      await flush();
    });

    expect(result.current.errors).toHaveLength(1);
    expect(result.current.errors[0].level).toBe("warn");
  });

  it("ignores messages from non-shipit sources", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      window.postMessage({ source: "other", type: "error", message: "nope" }, "*");
      await flush();
    });

    expect(result.current.errors).toHaveLength(0);
  });

  it("ignores messages without shipit-preview source", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      window.postMessage({ type: "error", message: "nope" }, "*");
      await flush();
    });

    expect(result.current.errors).toHaveLength(0);
  });

  it("deduplicates identical errors within 1s window", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      postPreviewError({ message: "Same error" });
      await flush();
    });

    await act(async () => {
      postPreviewError({ message: "Same error" });
      await flush();
    });

    expect(result.current.errors).toHaveLength(1);
  });

  it("allows same error after dedup window expires", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      postPreviewError({ message: "Same error" });
      await flush();
    });

    expect(result.current.errors).toHaveLength(1);

    // Advance past the dedup window (1000ms)
    await act(async () => {
      vi.advanceTimersByTime(1100);
      postPreviewError({ message: "Same error" });
      await flush();
    });

    expect(result.current.errors).toHaveLength(2);
  });

  it("enforces max buffer size of 50", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    for (let i = 0; i < 55; i++) {
      await act(async () => {
        postPreviewError({ message: `Error ${i}` });
        await flush();
      });
    }

    expect(result.current.errors.length).toBeLessThanOrEqual(50);
    // Oldest errors should have been dropped
    expect(result.current.errors[0].message).toBe("Error 5");
  });

  it("clearErrors resets the list and dedup state", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      postPreviewError({ message: "An error" });
      await flush();
    });

    expect(result.current.errors).toHaveLength(1);

    act(() => {
      result.current.clearErrors();
    });

    expect(result.current.errors).toHaveLength(0);
    expect(result.current.hasErrors).toBe(false);

    // Same error should be allowed again after clear
    await act(async () => {
      postPreviewError({ message: "An error" });
      await flush();
    });

    expect(result.current.errors).toHaveLength(1);
  });

  it("captures source and line info from error events", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      postPreviewError({
        message: "TypeError",
        fileSrc: "http://localhost:5173/src/main.tsx",
        line: 42,
        col: 10,
        stack: "Error at main.tsx:42",
      });
      await flush();
    });

    const err = result.current.errors[0];
    expect(err.source).toBe("http://localhost:5173/src/main.tsx");
    expect(err.line).toBe(42);
    expect(err.col).toBe(10);
    expect(err.stack).toBe("Error at main.tsx:42");
  });

  it("assigns unique IDs to each error", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      postPreviewError({ message: "Error 1" });
      await flush();
    });

    await act(async () => {
      postPreviewError({ message: "Error 2" });
      await flush();
    });

    expect(result.current.errors[0].id).not.toBe(result.current.errors[1].id);
  });

  it("ignores empty console messages", async () => {
    const { result } = renderHook(() => usePreviewErrors());

    await act(async () => {
      postConsoleError([]);
      await flush();
    });

    expect(result.current.errors).toHaveLength(0);
  });

  it("cleans up listener on unmount", async () => {
    const { unmount } = renderHook(() => usePreviewErrors());
    const spy = vi.spyOn(window, "removeEventListener");
    unmount();
    expect(spy).toHaveBeenCalledWith("message", expect.any(Function));
    spy.mockRestore();
  });
});
