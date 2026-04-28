import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useNotification } from "./useNotification.js";

afterEach(() => {
  cleanup();
  document.title = "ShipIt";
});

describe("useNotification", () => {
  let visibilityListeners: (() => void)[];
  let hiddenValue: boolean;

  beforeEach(() => {
    visibilityListeners = [];
    hiddenValue = false;
    document.title = "ShipIt";

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hiddenValue,
    });

    // Intercept visibilitychange listeners
    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, handler, options?) => {
      if (type === "visibilitychange") {
        visibilityListeners.push(handler as () => void);
      } else {
        origAdd(type, handler as EventListener, options);
      }
    });
    vi.spyOn(document, "removeEventListener").mockImplementation((type, handler, options?) => {
      if (type === "visibilitychange") {
        const idx = visibilityListeners.indexOf(handler as () => void);
        if (idx >= 0) visibilityListeners.splice(idx, 1);
      } else {
        origRemove(type, handler as EventListener, options);
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setHidden(hidden: boolean) {
    hiddenValue = hidden;
    for (const fn of visibilityListeners) fn();
  }

  it("does not change title when tab is visible", () => {
    hiddenValue = false;
    const { result } = renderHook(() => useNotification());
    act(() => result.current.notify("done"));
    expect(document.title).toBe("ShipIt");
  });

  it("changes title when tab is hidden", () => {
    const { result } = renderHook(() => useNotification());
    act(() => setHidden(true));
    act(() => result.current.notify("done"));
    expect(document.title).toBe("\u2713 Agent finished \u2014 ShipIt");
  });

  it("restores title when user returns to the tab", () => {
    const { result } = renderHook(() => useNotification());
    act(() => setHidden(true));
    act(() => result.current.notify("done"));
    expect(document.title).toBe("\u2713 Agent finished \u2014 ShipIt");

    act(() => setHidden(false));
    expect(document.title).toBe("ShipIt");
  });

  it("does not restore title if it was never changed", () => {
    renderHook(() => useNotification());
    document.title = "Custom Title";
    act(() => setHidden(false));
    // Should not touch the title since notify was never called
    expect(document.title).toBe("Custom Title");
  });

  it("sends browser notification when tab is hidden and permission is granted", () => {
    const mockNotification = vi.fn();
    vi.stubGlobal("Notification", Object.assign(mockNotification, { permission: "granted", requestPermission: vi.fn() }));

    const { result } = renderHook(() => useNotification());
    act(() => setHidden(true));
    act(() => result.current.notify("The agent has finished responding."));

    expect(mockNotification).toHaveBeenCalledWith("ShipIt", { body: "The agent has finished responding." });
    vi.unstubAllGlobals();
  });

  it("includes repo label in notification title and session name in body", () => {
    const mockNotification = vi.fn();
    vi.stubGlobal("Notification", Object.assign(mockNotification, { permission: "granted", requestPermission: vi.fn() }));

    const { result } = renderHook(() => useNotification());
    act(() => setHidden(true));
    act(() => result.current.notify("The agent has finished responding.", {
      sessionName: "Fix login bug",
      repoLabel: "acme/app",
    }));

    expect(mockNotification).toHaveBeenCalledWith("ShipIt · acme/app", {
      body: "[Fix login bug] The agent has finished responding.",
    });
    expect(document.title).toBe("✓ Fix login bug — ShipIt");
    vi.unstubAllGlobals();
  });

  it("focuses window and closes notification on click", () => {
    const instances: any[] = [];
    const mockNotification = vi.fn().mockImplementation(function (this: any) {
      instances.push(this);
    });
    vi.stubGlobal("Notification", Object.assign(mockNotification, { permission: "granted", requestPermission: vi.fn() }));

    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    const { result } = renderHook(() => useNotification());
    act(() => setHidden(true));
    act(() => result.current.notify("done"));

    expect(instances).toHaveLength(1);
    const notif = instances[0]!;
    notif.close = vi.fn();
    notif.onclick();

    expect(focusSpy).toHaveBeenCalled();
    expect(notif.close).toHaveBeenCalled();

    focusSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("does not send browser notification when permission is not granted", () => {
    const mockNotification = vi.fn();
    vi.stubGlobal("Notification", Object.assign(mockNotification, { permission: "denied", requestPermission: vi.fn() }));

    const { result } = renderHook(() => useNotification());
    act(() => setHidden(true));
    act(() => result.current.notify("done"));

    expect(mockNotification).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not send browser notification when tab is visible", () => {
    const mockNotification = vi.fn();
    vi.stubGlobal("Notification", Object.assign(mockNotification, { permission: "granted", requestPermission: vi.fn() }));

    const { result } = renderHook(() => useNotification());
    hiddenValue = false;
    act(() => result.current.notify("done"));

    expect(mockNotification).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("requestPermission calls Notification.requestPermission when permission is default", () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "default", requestPermission });

    const { result } = renderHook(() => useNotification());
    act(() => result.current.requestPermission());

    expect(requestPermission).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("requestPermission does nothing when permission is already granted", () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });

    const { result } = renderHook(() => useNotification());
    act(() => result.current.requestPermission());

    expect(requestPermission).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("requestPermission does nothing when Notification API is unavailable", () => {
    // In jsdom, Notification may not exist by default — make sure it's absent
    const original = (globalThis as any).Notification;
    delete (globalThis as any).Notification;

    const { result } = renderHook(() => useNotification());
    // Should not throw
    act(() => result.current.requestPermission());

    // Restore
    if (original) (globalThis as any).Notification = original;
  });

  it("cleans up visibility listener on unmount", () => {
    const { unmount } = renderHook(() => useNotification());
    expect(visibilityListeners.length).toBe(1);
    unmount();
    expect(visibilityListeners.length).toBe(0);
  });
});
