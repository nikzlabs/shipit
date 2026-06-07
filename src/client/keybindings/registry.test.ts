import { describe, it, expect } from "vitest";
import {
  KEYBINDINGS,
  EDITABLE_KEYBINDING_IDS,
  getKeybindingDef,
  isValidChord,
  eventMatchesChord,
  chordToKeys,
  chordFromEvent,
} from "./registry.js";

function kd(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("registry shape", () => {
  it("has unique ids", () => {
    const ids = KEYBINDINGS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every editable binding has a valid default chord", () => {
    for (const id of EDITABLE_KEYBINDING_IDS) {
      const def = getKeybindingDef(id);
      expect(isValidChord(def.defaultBinding, def.requiresSecondModifier)).toBe(true);
    }
  });

  it("throws on unknown id", () => {
    // @ts-expect-error — testing the runtime guard
    expect(() => getKeybindingDef("nope")).toThrow();
  });
});

describe("isValidChord", () => {
  it("requires a base key", () => {
    expect(isValidChord("mod+shift")).toBe(false);
  });
  it("requires a strong modifier", () => {
    expect(isValidChord("a")).toBe(false);
    expect(isValidChord("shift+a")).toBe(false);
  });
  it("accepts a single-modifier chord by default", () => {
    expect(isValidChord("mod+/")).toBe(true);
    expect(isValidChord("mod+f")).toBe(true);
  });
  it("requires a second modifier when asked", () => {
    expect(isValidChord("mod+n", true)).toBe(false);
    expect(isValidChord("mod+alt+n", true)).toBe(true);
    expect(isValidChord("ctrl+shift+space", true)).toBe(true);
  });
});

describe("eventMatchesChord", () => {
  it("matches mod chords on both ctrl and meta", () => {
    expect(eventMatchesChord(kd({ ctrlKey: true, key: "/" }), "mod+/")).toBe(true);
    expect(eventMatchesChord(kd({ metaKey: true, key: "/" }), "mod+/")).toBe(true);
  });
  it("matches multi-modifier chords", () => {
    expect(eventMatchesChord(kd({ ctrlKey: true, shiftKey: true, key: "o" }), "mod+shift+o")).toBe(true);
    expect(eventMatchesChord(kd({ ctrlKey: true, altKey: true, key: "n" }), "mod+alt+n")).toBe(true);
  });
  it("rejects when an unexpected modifier is held", () => {
    expect(eventMatchesChord(kd({ ctrlKey: true, shiftKey: true, key: "/" }), "mod+/")).toBe(false);
    expect(eventMatchesChord(kd({ ctrlKey: true, key: "o" }), "mod+shift+o")).toBe(false);
  });
  it("matches a bare named key like Escape", () => {
    expect(eventMatchesChord(kd({ key: "Escape" }), "escape")).toBe(true);
  });
  it("is case-insensitive on the base key", () => {
    expect(eventMatchesChord(kd({ ctrlKey: true, shiftKey: true, key: "O" }), "mod+shift+o")).toBe(true);
  });
});

describe("chordToKeys", () => {
  it("renders modifiers and key", () => {
    expect(chordToKeys("mod+shift+o").at(-1)).toBe("O");
    expect(chordToKeys("ctrl+shift+space").at(-1)).toBe("Space");
  });
  it("returns [] for empty", () => {
    expect(chordToKeys("")).toEqual([]);
  });
});

describe("chordFromEvent", () => {
  it("ignores pure modifier presses", () => {
    expect(chordFromEvent(kd({ key: "Shift", shiftKey: true }))).toBeNull();
  });
  it("normalizes ctrl/meta to mod", () => {
    expect(chordFromEvent(kd({ key: "o", ctrlKey: true, shiftKey: true }))).toBe("mod+shift+o");
    expect(chordFromEvent(kd({ key: "o", metaKey: true, shiftKey: true }))).toBe("mod+shift+o");
  });
  it("maps space", () => {
    expect(chordFromEvent(kd({ key: " ", ctrlKey: true, shiftKey: true }))).toBe("mod+shift+space");
  });
});
