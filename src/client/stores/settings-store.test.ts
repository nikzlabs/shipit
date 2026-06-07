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

describe("settings-store keybindings (docs/180)", () => {
  beforeEach(() => {
    useSettingsStore.setState({ keybindings: {} });
    localStorage.removeItem("shipit-keybindings");
  });

  it("getKeybinding falls back to the registry default", () => {
    expect(useSettingsStore.getState().getKeybinding("new-session")).toBe("mod+shift+o");
  });

  it("setKeybinding overrides and persists", () => {
    useSettingsStore.getState().setKeybinding("new-session", "mod+shift+k");
    expect(useSettingsStore.getState().getKeybinding("new-session")).toBe("mod+shift+k");
    expect(JSON.parse(localStorage.getItem("shipit-keybindings")!)).toEqual({ "new-session": "mod+shift+k" });
  });

  it("resetKeybinding reverts to the default and drops the override", () => {
    useSettingsStore.getState().setKeybinding("new-session", "mod+shift+k");
    useSettingsStore.getState().resetKeybinding("new-session");
    expect(useSettingsStore.getState().getKeybinding("new-session")).toBe("mod+shift+o");
    expect(useSettingsStore.getState().keybindings["new-session"]).toBeUndefined();
  });
});

describe("settings-store GitHub rate-limit state", () => {
  beforeEach(() => {
    useSettingsStore.setState({ githubRateLimit: null });
  });

  it("setGithubRateLimit stores the resetAt timestamp", () => {
    useSettingsStore.getState().setGithubRateLimit({ resetAt: 1747843200000 });
    expect(useSettingsStore.getState().githubRateLimit).toEqual({ resetAt: 1747843200000 });
  });

  it("setGithubRateLimit(null) clears the rate-limit state", () => {
    useSettingsStore.getState().setGithubRateLimit({ resetAt: 1747843200000 });
    useSettingsStore.getState().setGithubRateLimit(null);
    expect(useSettingsStore.getState().githubRateLimit).toBeNull();
  });

  it("accepts null resetAt (limit active but no reset known)", () => {
    useSettingsStore.getState().setGithubRateLimit({ resetAt: null });
    expect(useSettingsStore.getState().githubRateLimit).toEqual({ resetAt: null });
  });
});
