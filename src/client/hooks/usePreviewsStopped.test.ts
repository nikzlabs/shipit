/**
 * planning#496 — releasing iframe-pool slots for sessions whose previews died.
 *
 * The behaviour that matters is the *guard*: this may only ever reclaim
 * background slots. Dropping the iframe the user is looking at is the failure
 * mode the pool's docstring exists to prevent, and it is what the previously
 * reverted prune actually did.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  notifyPreviewsStopped,
  useReleaseStoppedPreviews,
  usePreviewsStopped,
  _resetPreviewsStoppedListeners,
} from "./usePreviewsStopped.js";

afterEach(() => {
  cleanup();
  _resetPreviewsStoppedListeners();
});

describe("useReleaseStoppedPreviews", () => {
  it("releases a background session's slots", () => {
    const drop = vi.fn(() => []);
    renderHook(() => useReleaseStoppedPreviews("session-active", drop));

    act(() => { notifyPreviewsStopped("session-background"); });

    expect(drop).toHaveBeenCalledWith("session-background");
  });

  it("never releases the session the user is looking at", () => {
    // The active session's preview stopping is handled where the user can see
    // it (planning#478's waiting overlay), and pulling its iframe out from
    // under them is exactly what this must not do.
    const drop = vi.fn(() => []);
    renderHook(() => useReleaseStoppedPreviews("session-active", drop));

    act(() => { notifyPreviewsStopped("session-active"); });

    expect(drop).not.toHaveBeenCalled();
  });

  it("still releases when no session is active", () => {
    // `sessionId` is undefined before a session is selected. `undefined` must
    // not accidentally equal the stopped session and suppress the reclaim.
    const drop = vi.fn(() => []);
    renderHook(() => useReleaseStoppedPreviews(undefined, drop));

    act(() => { notifyPreviewsStopped("session-background"); });

    expect(drop).toHaveBeenCalledWith("session-background");
  });

  it("follows the active session as the user switches", () => {
    // The guard reads the CURRENT active session, not the one bound at mount —
    // a stale capture would protect the session the user has already left and
    // reclaim the one they just switched to.
    const drop = vi.fn(() => []);
    const { rerender } = renderHook(
      ({ active }: { active: string }) => useReleaseStoppedPreviews(active, drop),
      { initialProps: { active: "session-one" } },
    );

    rerender({ active: "session-two" });
    act(() => { notifyPreviewsStopped("session-two"); });
    expect(drop).not.toHaveBeenCalled();

    act(() => { notifyPreviewsStopped("session-one"); });
    expect(drop).toHaveBeenCalledWith("session-one");
  });

  it("stops listening once unmounted", () => {
    const drop = vi.fn(() => []);
    const { unmount } = renderHook(() => useReleaseStoppedPreviews("session-active", drop));

    unmount();
    act(() => { notifyPreviewsStopped("session-background"); });

    expect(drop).not.toHaveBeenCalled();
  });
});

describe("usePreviewsStopped", () => {
  it("invokes the latest handler, not the one bound at mount", () => {
    // The handler is read through a ref so an inline arrow does not churn the
    // subscription; the flip side is that it must still be the current one.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ handler }: { handler: (id: string) => void }) => usePreviewsStopped(handler),
      { initialProps: { handler: first } },
    );

    rerender({ handler: second });
    act(() => { notifyPreviewsStopped("session-x"); });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("session-x");
  });

  it("delivers to every mounted subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() => usePreviewsStopped(a));
    renderHook(() => usePreviewsStopped(b));

    act(() => { notifyPreviewsStopped("session-x"); });

    expect(a).toHaveBeenCalledWith("session-x");
    expect(b).toHaveBeenCalledWith("session-x");
  });
});
