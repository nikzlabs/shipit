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
  SETTINGS_PATH,
  initialSettingValues,
  ownRouteOf,
  readBrowserValue,
  settingRequest,
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

/**
 * Each key's saved value written the way it is already on disk, both ways round.
 *
 * The four kinds below the booleans are slice 4's: a choice and a line of text
 * were written by `saveString` and read by `getSavedString`, and the speed was
 * written by `String(value)` and parsed back with `Number`. `stored` is exactly
 * what those wrote.
 */
const SAVED: readonly { key: string; storageKey: string; stored: string; value: unknown }[] = [
  { key: "advanced.compactConversation", storageKey: "shipit-compact-conversation", stored: "true", value: true },
  { key: "advanced.compactConversation", storageKey: "shipit-compact-conversation", stored: "false", value: false },
  { key: "advanced.notifyOnFinish", storageKey: "shipit-notify-on-finish", stored: "false", value: false },
  { key: "advanced.notifyOnFinish", storageKey: "shipit-notify-on-finish", stored: "true", value: true },
  { key: "advanced.soundOnFinish", storageKey: "shipit-sound-on-finish", stored: "false", value: false },
  { key: "advanced.soundOnFinish", storageKey: "shipit-sound-on-finish", stored: "true", value: true },
  { key: "voice.sttProvider", storageKey: "shipit-stt-provider", stored: "deepgram", value: "deepgram" },
  { key: "voice.ttsProvider", storageKey: "shipit-tts-provider", stored: "elevenlabs", value: "elevenlabs" },
  { key: "voice.language", storageKey: "shipit-voice-language", stored: "fr", value: "fr" },
  // The declared default is "" — Auto — so a stored "" has to survive as itself
  // rather than being mistaken for nothing stored.
  { key: "voice.language", storageKey: "shipit-voice-language", stored: "", value: "" },
  { key: "voice.ttsVoice", storageKey: "shipit-tts-voice", stored: "shimmer", value: "shimmer" },
  { key: "voice.ttsSpeed", storageKey: "shipit-tts-speed", stored: "1.25", value: 1.25 },
  { key: "voice.ttsSpeed", storageKey: "shipit-tts-speed", stored: "0.8", value: 0.8 },
  { key: "voice.inputEnabled", storageKey: "shipit-voice-input-enabled", stored: "true", value: true },
  { key: "voice.cleanupEnabled", storageKey: "shipit-voice-cleanup-enabled", stored: "false", value: false },
  { key: "voice.playbackEnabled", storageKey: "shipit-voice-playback-enabled", stored: "true", value: true },
  { key: "voice.handsFree", storageKey: "shipit-voice-hands-free", stored: "true", value: true },
];

describe("a value the user already saved is still read afterwards", () => {
  for (const { key, storageKey, stored, value } of SAVED) {
    it(`reads ${key} back as ${JSON.stringify(value)}`, () => {
      localStorage.setItem(storageKey, stored);

      expect(readBrowserValue(declarationOf(key))).toBe(value);
      expect(initialSettingValues()[key]).toBe(value);
    });
  }

  it("writes the same text the accessors it replaces wrote", () => {
    for (const { key, storageKey, stored, value } of SAVED) {
      writeBrowserValue(declarationOf(key), value);
      expect(localStorage.getItem(storageKey)).toBe(stored);
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

  /*
    A choice and a speed are the two the raw accessors got wrong. `getSavedString`
    handed back any stored text, so a provider the catalogue no longer offers
    reached a `<select>` that has no such option and rendered blank; the speed
    accessor accepted any number above zero, including one outside the range the
    declaration states. Both now answer the declared default, because the codec
    hands the decoded value to the value type rather than past it.
  */
  it("reads an option the catalogue no longer offers as the default", () => {
    localStorage.setItem("shipit-stt-provider", "a-provider-that-was-removed");
    expect(readBrowserValue(declarationOf("voice.sttProvider"))).toBe("openai");
  });

  it("reads a number outside the declared range as the default", () => {
    localStorage.setItem("shipit-tts-speed", "9");
    expect(readBrowserValue(declarationOf("voice.ttsSpeed"))).toBe(1);
    localStorage.setItem("shipit-tts-speed", "not a number");
    expect(readBrowserValue(declarationOf("voice.ttsSpeed"))).toBe(1);
  });

  it("falls back, and does not throw, when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const declaration = declarationOf("advanced.notifyOnFinish");

    expect(readBrowserValue(declaration)).toBe(true);
    expect(() => { writeBrowserValue(declaration, false); }).not.toThrow();
  });
});

describe("the record covers the settings the converted tabs generate", () => {
  it("holds every row on the converted tabs and nothing else", () => {
    expect(GENERATED_SETTINGS.map((d) => d.key)).toEqual([
      "advanced.releaseChannel",
      "advanced.enableSubAgents",
      "advanced.liveSteering",
      "advanced.autoFixCi",
      "advanced.sessionStatusCard",
      "advanced.autoResolveConflicts",
      "advanced.autoResetMergedBranch",
      "advanced.memoryBudgetMb",
      "integrations.autoCreatePr",
      "git.identity",
      "instructions.userInstructions",
      "instructions.opsInstructions",
      "instructions.agentInstructionsEnabled",
      "voice.deliveryMode",
      "services.nonTurnModel",
      "network.egressContained",
      "services.credentials",
      "services.accountSelectionMode",
      "services.failoverCutoff.session",
      "services.failoverCutoff.weekly",
      "services.providerAccounts",
      "roles",
      "reviewers",
      "integrations.github.connection",
      "integrations.linear.credential",
      "integrations.sshHosts",
      "mcp.servers",
      "mcp.oauthProvider",
      "network.egress.hosts",
      "voice.providerKey",
      "voice.webhook.url",
      "voice.webhook.token",
      "keyboard.keybindings",
      "voice.inputEnabled",
      "voice.sttProvider",
      "voice.cleanupEnabled",
      "voice.language",
      "voice.playbackEnabled",
      "voice.ttsProvider",
      "voice.ttsVoice",
      "voice.ttsSpeed",
      "voice.handsFree",
      "advanced.compactConversation",
      "advanced.notifyOnFinish",
      "advanced.soundOnFinish",
    ]);
  });

  /*
    P11 — `voice.providerKey` is addressed by a provider and belongs to no
    collection declaration, so the list that repeats it is its owner and it is a
    row. Its value is NOT the record's: a key is written per provider and never
    read back, so a value here would be one nothing ever hydrates, under a reader
    that prefers the record to the named field.
  */
  it("renders an addressed declaration that names a component, and holds no value for it", () => {
    const declaration = findSetting("voice.providerKey")!;
    expect(declaration.address?.kind).toBe("item");
    expect(GENERATED_SETTINGS).toContain(declaration);
    expect(Object.keys(initialSettingValues())).not.toContain("voice.providerKey");
  });

  /*
    The other half of P11, written against the rule because nothing declares it
    today: an addressed declaration with no component belongs to a panel, which
    renders it per item. The fixture is a row that IS generated — a choice the
    codec can spell, over a store the writer reaches — so the address is the only
    thing left to keep it out. Generating it would put one control on screen for
    a setting that exists once per provider, per server or per host.
  */
  it("leaves an addressed declaration that names no component out", () => {
    const perItem = {
      ...declarationOf("voice.sttProvider"),
      key: "voice.somethingPerProvider",
      address: { kind: "item", noun: "a speech provider id" },
    } as AnySettingDeclaration;

    expect(isGeneratedRow({ ...perItem, address: undefined })).toBe(true);
    expect(isGeneratedRow(perItem)).toBe(false);
  });

  // A component is why the memory budget is a row: its value kind has no
  // control, and the block renders it because the declaration names one (req 3).
  it("takes in a declaration whose value kind has no control, when it names a component", () => {
    const declaration = findSetting("advanced.memoryBudgetMb")!;
    expect(declaration.type.kind).toBe("number");
    expect(declaration.component).toBe("memory-budget");
    expect(GENERATED_SETTINGS).toContain(declaration);
  });

  /*
    A collection panel, since slice 6: the collection names its component and is
    a row, while the field the panel repeats per item names none and stays out.
    Neither enters the RECORD — a bespoke store is one the shared writer cannot
    reach — so membership of the rows is wider than membership of the record.
  */
  it("takes in a collection that names a panel, without holding its value", () => {
    const keys = GENERATED_SETTINGS.map((d) => d.key);
    expect(keys).toContain("network.egress.hosts");
    expect(keys).not.toContain("network.egress.hosts[].host");
    expect(Object.keys(initialSettingValues())).not.toContain("network.egress.hosts");
  });

  it("seeds a payload setting from its declared default", () => {
    expect(initialSettingValues()["advanced.liveSteering"]).toBe(true);
    expect(initialSettingValues()["advanced.autoFixCi"]).toBe(false);
  });
});

/**
 * The request a declaration produces (P2), asked of a SYNTHETIC one.
 *
 * Every other test of this goes through a control and compares the request
 * against the real catalogue, which the same literals hard-coded would also
 * satisfy. This is the claim itself: change the declaration and the request
 * changes with it, because nothing else decides it.
 */
describe("the request a declaration names", () => {
  it("takes the method, the path and the body field from the store", () => {
    const moved = {
      ...declarationOf("network.egressContained"),
      store: { kind: "own-route", method: "POST", path: "/api/somewhere-else", bodyField: "thing" },
    } as AnySettingDeclaration;

    expect(settingRequest(moved, true))
      .toEqual({ method: "POST", path: "/api/somewhere-else", body: { thing: true } });
  });

  it("takes the payload's one address and the declaration's wire", () => {
    const payload = declarationOf("advanced.autoFixCi");

    expect(settingRequest(payload, true))
      .toEqual({ method: "PUT", path: SETTINGS_PATH, body: { [payload.wire!]: true } });
  });

  // A panel owns its own write, so there is no request to build for one.
  it("has none for a store the shared writer cannot reach", () => {
    expect(settingRequest(declarationOf("mcp.servers[].name"), "x")).toBeNull();
  });
});

/**
 * A credential the dialog writes and never reads back (slice 5).
 *
 * Its address STORES the value and answers no GET, so the record has nothing to
 * hold for it: a value seeded there would be the declared default for ever,
 * preferred by the reader over the named field, while `refreshOwnRouteSettings`
 * asked a path that can only 404 — on every settings refresh, not once. It is
 * still a ROW, because its declaration names a component, which is the same
 * split `voice.providerKey` has: membership of the record is narrower than
 * membership of the rows.
 *
 * **`emits: configuredOnly()` is not what says this.** That is the agent's
 * projection, and `voice.webhook.url` carries it while being read back in full.
 */
describe("an address that only stores", () => {
  const WRITE_ONLY = GENERATED_SETTINGS.filter((d) => ownRouteOf(d)?.writeOnly);

  it("covers the credentials declared this way", () => {
    expect(WRITE_ONLY.map((d) => d.key).sort())
      .toEqual(["integrations.github.connection", "integrations.linear.credential"]);
  });

  for (const declaration of WRITE_ONLY) {
    it(`renders ${declaration.key} as a row, and holds no value for it`, () => {
      expect(GENERATED_SETTINGS).toContain(declaration);
      expect(Object.keys(initialSettingValues())).not.toContain(declaration.key);
      expect(OWN_ROUTE_SETTINGS).not.toContain(declaration);
    });
  }

  /*
    What keeps them out is the flag and not the store kind, the component or the
    `emits`: an own-route row without it is recorded and read, and one of those
    is `configuredOnly` too.
  */
  it("still holds an own-route value the path does answer", () => {
    const webhook = declarationOf("voice.webhook.url");

    expect(webhook.emits.kind).toBe("configured_only");
    expect(ownRouteOf(webhook)?.writeOnly).toBeUndefined();
    expect(Object.keys(initialSettingValues())).toContain("voice.webhook.url");
    expect(OWN_ROUTE_SETTINGS).toContain(webhook);
  });
});

/*
  Written against the rule rather than against today's catalogue: no browser enum
  is declared yet, and the first one arrives with the voice settings in slice 4 —
  by which time a row that renders, changes on screen and writes nothing would
  already have shipped.
*/
describe("a browser value the store cannot spell", () => {
  /*
    A composite: the control table has one, so the fixture reaches the codec gate
    rather than stopping at "no control for this kind" — which is what the first
    cut of this test did, leaving the gate itself unexercised. `localStorage`
    holds strings and nothing encodes a name-and-email pair, so a row that
    rendered would change on screen and store nothing.
  */
  const browserComposite = {
    ...declarationOf("git.identity"),
    key: "advanced.somethingPaired",
    tab: "advanced",
    store: { kind: "browser", localStorageKey: "shipit-something-paired" },
  } as AnySettingDeclaration;

  it("is not a generated row, because nothing could encode it", () => {
    expect(browserComposite.store.kind).toBe("browser");
    expect(isGeneratedRow({ ...browserComposite, store: declarationOf("git.identity").store }))
      .toBe(true);
    expect(isGeneratedRow(browserComposite)).toBe(false);
  });

  it("is a generated row for a kind the codec does spell", () => {
    expect(isGeneratedRow(declarationOf("advanced.compactConversation"))).toBe(true);
  });
});

/*
  The textarea rule as a GATE (plan.md → The renderer). `text`'s control is a
  textarea and the `system-prompt-file` store is what says a value is prose —
  which is why the design rejected a `presentation: "multiline"` field. So a
  `text` row over another store has no control yet and must not be generated,
  and this is written against the rule rather than against today's catalogue:
  the first such declaration is a slice away, and by then a row that renders and
  cannot be shown would already have shipped.
*/
describe("a text value whose store is not the prompt files", () => {
  const credentialText = {
    ...declarationOf("instructions.userInstructions"),
    key: "instructions.somethingTyped",
    store: { kind: "credential-store", field: "somethingTyped" },
  } as AnySettingDeclaration;

  it("is not a generated row, because the control table has no input", () => {
    expect(credentialText.type.kind).toBe("text");
    expect(isGeneratedRow(credentialText)).toBe(false);
  });

  it("is a generated row when the store is the one whose values are prose", () => {
    expect(isGeneratedRow(declarationOf("instructions.userInstructions"))).toBe(true);
  });
});

describe("the rows the settings payload does not carry", () => {
  it("names the settings written through a route of their own", () => {
    expect(OWN_ROUTE_SETTINGS.map((d) => d.key)).toEqual([
      "advanced.releaseChannel",
      "network.egressContained",
      "voice.webhook.url",
      "voice.webhook.token",
    ]);
  });

  /*
    Two declarations at ONE address, which is what says they share a write
    (plan.md → Slices → 4). The webhook is one credential in two halves, and the
    address is where that fact lives: the pair is a component because of how it
    LOOKS, and one request because of what the declarations say.
  */
  it("gives the two webhook halves the same address and different fields", () => {
    const url = ownRouteOf(declarationOf("voice.webhook.url"));
    const token = ownRouteOf(declarationOf("voice.webhook.token"));
    expect(url?.path).toBe("/api/voice/webhook");
    expect(token?.path).toBe(url?.path);
    expect(url?.method).toBe("POST");
    expect(token?.method).toBe(url?.method);
    expect([url?.bodyField, token?.bodyField]).toEqual(["url", "token"]);
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
