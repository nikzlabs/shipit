import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, cleanup, waitFor } from "@testing-library/react";
import { useLazyToolInput } from "./useLazyToolInput.js";
import { useSessionStore } from "../stores/session-store.js";

beforeEach(() => {
  useSessionStore.setState({ sessionId: "session-1" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSessionStore.getState().reset();
});

function okFetch(input: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ input }) });
}

/**
 * docs/244 / planning#298 — the shared fetch behind the three views that display an
 * input key the serve-path projection removed: the diff modal, the tool-call
 * modal, and the subagent prompt disclosure. The component tests prove each
 * view uses it; these pin the behavior none of them can observe on its own.
 */
describe("useLazyToolInput", () => {
  it("does nothing until it is enabled — the click is the trigger", async () => {
    const fetchMock = okFetch({ prompt: "p" });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useLazyToolInput("t1", enabled),
      { initialProps: { enabled: false } },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.input).toEqual({ prompt: "p" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/session-1/tool-inputs/t1");
  });

  it("fetches once per tool call, not once per re-render", async () => {
    const fetchMock = okFetch({ prompt: "p" });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(() => useLazyToolInput("t1", true));
    await waitFor(() => expect(result.current.input).toBeDefined());

    rerender();
    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug class `useLazyResultBody` had to guard against too: a session
   * switch or a rewind re-points the same mounted component at a different tool
   * call, and the previous one's input must not show through in the gap before
   * the new fetch resolves.
   */
  it("does not show the previous tool call's input when re-pointed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ input: { prompt: "first" } }) })
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useLazyToolInput(id, true),
      { initialProps: { id: "t1" } },
    );
    await waitFor(() => expect(result.current.input).toEqual({ prompt: "first" }));

    rerender({ id: "t2" });
    expect(result.current.input).toBeUndefined();
    expect(result.current.loading).toBe(true);
  });

  it("reports an error rather than an empty input on a 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const { result } = renderHook(() => useLazyToolInput("t1", true));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.input).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  it("does not retry a failed fetch on every re-render", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(() => useLazyToolInput("t1", true));
    await waitFor(() => expect(result.current.error).toBe(true));

    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stays idle with no session or no tool-use id", () => {
    const fetchMock = okFetch({});
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLazyToolInput(undefined, true));
    expect(result.current.loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
