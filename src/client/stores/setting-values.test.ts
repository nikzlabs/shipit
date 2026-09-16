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
import {
  GENERATED_SETTINGS,
  isGeneratedRow,
  OWN_ROUTE_SETTINGS,
  initialSettingValues,
  ownRouteOf,
  readBrowserValue,
  writeBrowserValue,
} from "./setting-values.js";
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
  it("holds every row on the two converted tabs and nothing else", () => {
    expect(GENERATED_SETTINGS.map((d) => d.key)).toEqual([
      "advanced.releaseChannel",
      "advanced.enableSubAgents",
      "advanced.liveSteering",
      "advanced.autoFixCi",
      "advanced.sessionStatusCard",
      "advanced.autoResolveConflicts",
      "advanced.autoResetMergedBranch",
      "advanced.memoryBudgetMb",
      "network.egressContained",
      "advanced.compactConversation",
      "advanced.notifyOnFinish",
      "advanced.soundOnFinish",
    ]);
  });

  // A component is why the memory budget is a row: its value kind has no
  // control, and the block renders it because the declaration names one (req 3).
  it("takes in a declaration whose value kind has no control, when it names a component", () => {
    const declaration = findSetting("advanced.memoryBudgetMb")!;
    expect(declaration.type.kind).toBe("number");
    expect(declaration.component).toBe("memory-budget");
    expect(GENERATED_SETTINGS).toContain(declaration);
  });

  // The Network tab's panels are slice 6, so its collection and its per-item
  // field stay hand-written while the one value on it is generated (P18).
  it("leaves the Network tab's panel declarations out", () => {
    const keys = GENERATED_SETTINGS.map((d) => d.key);
    expect(keys).not.toContain("network.egress.hosts");
    expect(keys).not.toContain("network.egress.hosts[].host");
  });

  it("seeds a payload setting from its declared default", () => {
    expect(initialSettingValues()["advanced.liveSteering"]).toBe(true);
    expect(initialSettingValues()["advanced.autoFixCi"]).toBe(false);
  });
});

/*
  Written against the rule rather than against today's catalogue: no browser enum
  is declared yet, and the first one arrives with the voice settings in slice 4 —
  by which time a row that renders, changes on screen and writes nothing would
  already have shipped.
*/
describe("a browser value the store cannot spell", () => {
  const browserEnum = {
    ...declarationOf("advanced.compactConversation"),
    key: "advanced.somethingChosen",
    type: { ...declarationOf("voice.sttProvider").type },
  } as AnySettingDeclaration;

  it("is not a generated row, because nothing could encode it", () => {
    expect(browserEnum.store.kind).toBe("browser");
    expect(browserEnum.type.kind).toBe("enum");
    expect(isGeneratedRow(browserEnum)).toBe(false);
  });

  it("is a generated row for a kind the codec does spell", () => {
    expect(isGeneratedRow(declarationOf("advanced.compactConversation"))).toBe(true);
  });
});

describe("the rows the settings payload does not carry", () => {
  it("names the two settings written through a route of their own", () => {
    expect(OWN_ROUTE_SETTINGS.map((d) => d.key)).toEqual([
      "advanced.releaseChannel",
      "network.egressContained",
    ]);
  });

  /*
    P2 — the write address and the read address are the same two facts. A route
    string could not have produced either payload below: the bodies differ, and
    neither declaration carries a `wire` to fall back on.
  */
  it("carries a method, a path and a body field for each", () => {
    expect(ownRouteOf(declarationOf("advanced.releaseChannel"))).toEqual({
      kind: "own-route", method: "POST", path: "/api/updates/channel", bodyField: "channel",
    });
    expect(ownRouteOf(declarationOf("network.egressContained"))).toEqual({
      kind: "own-route", method: "PUT", path: "/api/egress/settings", bodyField: "globalEnabled",
    });
  });

  it("is nothing at all for a setting stored in the payload", () => {
    expect(ownRouteOf(declarationOf("advanced.autoFixCi"))).toBeUndefined();
  });
});
