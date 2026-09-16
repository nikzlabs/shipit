/**
 * The browser store's codec, and the record it seeds
 * (docs/308-data-driven-settings req 9, inventory.md P17).
 *
 * The fixtures below are written in **today's** on-disk format — `String(enabled)`,
 * which is what `saveCompactConversation` and its two siblings have always
 * written — so they fail the moment the reader stops understanding a value the
 * user already saved. That is the whole defect P17 names: `bool.read("true")`
 * answers the declaration's default, not `true`, so a reader that handed stored
 * text to `type.read()` would silently reset every browser boolean.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GENERATED_SETTINGS, initialSettingValues, readBrowserValue, writeBrowserValue } from "./setting-values.js";
import { findSetting, type AnySettingDeclaration } from "../../server/shared/settings-catalogue/index.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function declarationOf(key: string): AnySettingDeclaration {
  const declaration = findSetting(key);
  if (!declaration) throw new Error(`no declaration for ${key}`);
  return declaration;
}

/** Each key's saved value written the way it is already on disk, both ways round. */
const SAVED: readonly { key: string; storageKey: string; saved: boolean }[] = [
  { key: "advanced.compactConversation", storageKey: "shipit-compact-conversation", saved: true },
  { key: "advanced.compactConversation", storageKey: "shipit-compact-conversation", saved: false },
  { key: "advanced.notifyOnFinish", storageKey: "shipit-notify-on-finish", saved: false },
  { key: "advanced.notifyOnFinish", storageKey: "shipit-notify-on-finish", saved: true },
  { key: "advanced.soundOnFinish", storageKey: "shipit-sound-on-finish", saved: false },
  { key: "advanced.soundOnFinish", storageKey: "shipit-sound-on-finish", saved: true },
];

describe("a value the user already saved is still read afterwards", () => {
  for (const { key, storageKey, saved } of SAVED) {
    it(`reads ${key} back as ${saved}`, () => {
      localStorage.setItem(storageKey, String(saved));

      expect(readBrowserValue(declarationOf(key))).toBe(saved);
      expect(initialSettingValues()[key]).toBe(saved);
    });
  }

  it("writes the same text the accessors it replaces wrote", () => {
    for (const { key, storageKey, saved } of SAVED) {
      writeBrowserValue(declarationOf(key), saved);
      expect(localStorage.getItem(storageKey)).toBe(String(saved));
    }
  });
});

describe("a browser value that was never saved", () => {
  it("reads as the declaration's default when the key is absent", () => {
    for (const { key } of SAVED) {
      const declaration = declarationOf(key);
      expect(readBrowserValue(declaration)).toBe(declaration.type.defaultValue);
    }
  });

  it("reads as the declaration's default for text ShipIt never wrote", () => {
    localStorage.setItem("shipit-compact-conversation", "invalid");
    expect(readBrowserValue(declarationOf("advanced.compactConversation"))).toBe(false);
  });

  it("falls back, and does not throw, when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const declaration = declarationOf("advanced.notifyOnFinish");

    expect(readBrowserValue(declaration)).toBe(true);
    expect(() => { writeBrowserValue(declaration, false); }).not.toThrow();
  });
});

describe("the record covers the settings this slice generates", () => {
  it("holds the Advanced tab's nine toggles and nothing else", () => {
    expect(GENERATED_SETTINGS.map((d) => d.key)).toEqual([
      "advanced.enableSubAgents",
      "advanced.liveSteering",
      "advanced.autoFixCi",
      "advanced.sessionStatusCard",
      "advanced.autoResolveConflicts",
      "advanced.autoResetMergedBranch",
      "advanced.compactConversation",
      "advanced.notifyOnFinish",
      "advanced.soundOnFinish",
    ]);
  });

  it("seeds a payload setting from its declared default", () => {
    expect(initialSettingValues()["advanced.liveSteering"]).toBe(true);
    expect(initialSettingValues()["advanced.autoFixCi"]).toBe(false);
  });
});
