import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "./settings-store.js";

beforeEach(() => {
  useSettingsStore.setState({
    permissionMode: "auto",
    permissionModeBySession: {},
  });
});

describe("settings-store permission mode", () => {
  it("falls back to the default when a session has no explicit mode", () => {
    useSettingsStore.getState().setPermissionMode(undefined, "plan");
    expect(useSettingsStore.getState().getPermissionMode("session-x")).toBe("plan");
  });

  it("scopes per-session toggles so they do not leak between sessions", () => {
    // Both sessions inherit the default ("auto"), then session A is flipped
    // into plan mode. Session B must remain on "auto".
    useSettingsStore.getState().setPermissionMode("session-a", "plan");
    expect(useSettingsStore.getState().getPermissionMode("session-a")).toBe("plan");
    expect(useSettingsStore.getState().getPermissionMode("session-b")).toBe("auto");

    // Toggling session B off does NOT clobber session A.
    useSettingsStore.getState().setPermissionMode("session-b", "auto");
    expect(useSettingsStore.getState().getPermissionMode("session-a")).toBe("plan");
  });

  it("treats sessionId=undefined as the pre-session default", () => {
    useSettingsStore.getState().setPermissionMode(undefined, "plan");
    expect(useSettingsStore.getState().permissionMode).toBe("plan");

    // Existing per-session entries override the default.
    useSettingsStore.getState().setPermissionMode("session-a", "auto");
    expect(useSettingsStore.getState().getPermissionMode("session-a")).toBe("auto");
    // …but a fresh session still inherits the updated default.
    expect(useSettingsStore.getState().getPermissionMode("session-fresh")).toBe("plan");
  });

  it("does not persist permission mode across reloads (no localStorage write)", () => {
    // Plan mode is per-conversation transient state — nothing should be
    // written to localStorage when toggling it.
    useSettingsStore.getState().setPermissionMode("session-a", "plan");
    useSettingsStore.getState().setPermissionMode(undefined, "plan");
    expect(localStorage.getItem("vibe-permission-mode")).toBeNull();
  });
});
