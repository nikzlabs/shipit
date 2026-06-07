import { describe, it, expect, beforeEach } from "vitest";
import { getSavedKeybindings, saveKeybindings } from "./local-storage.js";

beforeEach(() => {
  localStorage.clear();
});

describe("getSavedKeybindings (docs/180)", () => {
  it("returns {} with no stored data", () => {
    expect(getSavedKeybindings()).toEqual({});
  });

  it("reads the keybindings blob", () => {
    saveKeybindings({ "new-session": "mod+shift+k" });
    expect(getSavedKeybindings()).toEqual({ "new-session": "mod+shift+k" });
  });

  it("migrates legacy per-key entries when no blob exists", () => {
    localStorage.setItem("shipit-quick-capture-hotkey", "mod+alt+j");
    localStorage.setItem("shipit-voice-hotkey-mode-a", "ctrl+shift+u");
    localStorage.setItem("shipit-voice-hotkey-mode-b", "ctrl+shift+y");
    expect(getSavedKeybindings()).toEqual({
      "quick-capture": "mod+alt+j",
      "voice-mode-a": "ctrl+shift+u",
      "voice-mode-b": "ctrl+shift+y",
    });
  });

  it("prefers the blob over legacy keys once it exists", () => {
    localStorage.setItem("shipit-quick-capture-hotkey", "mod+alt+j");
    saveKeybindings({ "new-session": "mod+shift+k" });
    // Blob present → legacy keys are ignored.
    expect(getSavedKeybindings()).toEqual({ "new-session": "mod+shift+k" });
  });

  it("ignores non-string blob values", () => {
    localStorage.setItem("shipit-keybindings", JSON.stringify({ "new-session": 42, "quick-capture": "mod+alt+n" }));
    expect(getSavedKeybindings()).toEqual({ "quick-capture": "mod+alt+n" });
  });
});
