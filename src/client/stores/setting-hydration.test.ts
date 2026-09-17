/**
 * Where a generated row's value comes from on a page load
 * (docs/308-data-driven-settings req 1).
 *
 * The cases are enumerated FROM the catalogue, because that is what the claim
 * is: a row declared tomorrow is hydrated the day it is declared, with no edit
 * in this file or any other. Slice 1 left this open — a new row saved correctly
 * and came back as its default after a reload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateSettingValues, refreshOwnRouteSettings } from "./setting-hydration.js";
import {
  GENERATED_SETTINGS,
  OWN_ROUTE_SETTINGS,
  initialSettingValues,
  mirrorFieldOf,
  ownRouteOf,
} from "./setting-values.js";
import { useSettingsStore } from "./settings-store.js";
import {
  ALL_SETTINGS,
  type AnySettingDeclaration,
} from "../../server/shared/settings-catalogue/index.js";

/** Every generated row the settings payload carries, which is every one with a `wire`. */
const PAYLOAD_ROWS = GENERATED_SETTINGS.filter((d) => d.wire !== undefined);

/**
 * A value of each kind, written the way the payload carries it. Enumerated so a
 * kind that joins the record without a fixture fails here rather than being
 * hydrated with something nothing stores.
 */
function storedSample(declaration: AnySettingDeclaration): unknown {
  switch (declaration.type.kind) {
    case "bool": return declaration.type.defaultValue !== true;
    case "number": return 4096;
    // Any declared option but the default, so a hydration that quietly answered
    // the default would not pass.
    case "enum": return (declaration.type.shape as { options: { value: string }[] }).options
      .map((o) => o.value)
      .find((v) => v !== declaration.type.defaultValue)!;
    case "text": return "what the user typed";
    case "gitIdentity": return { name: "Ada", email: "ada@example.com" };
    case "modelSelection":
      return { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" };
    default:
      throw new Error(`no fixture for a ${declaration.type.kind} row (${declaration.key})`);
  }
}

/**
 * The rows the store ALSO holds under a named field (P1): the 51 read sites
 * keep reading those, so hydration has to move both. A row whose `wire` names
 * no field of the store — the instruction boxes, the git identity — is read
 * from the record alone.
 */
const MIRRORED = PAYLOAD_ROWS.filter((d) => {
  const field = mirrorFieldOf(d);
  return field !== undefined && field in useSettingsStore.getState();
});

function recorded(key: string): unknown {
  return useSettingsStore.getState().settingValues[key];
}

beforeEach(() => {
  useSettingsStore.setState({ settingValues: initialSettingValues() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("a payload's generated rows", () => {
  for (const declaration of PAYLOAD_ROWS) {
    it(`reads ${declaration.key} back from ${declaration.wire!}`, () => {
      const stored = storedSample(declaration);

      hydrateSettingValues({ [declaration.wire!]: stored });

      expect(recorded(declaration.key)).toEqual(stored);
    });
  }

  // The named field the other 51 read sites use is a view over the record.
  for (const declaration of MIRRORED) {
    it(`keeps ${declaration.wire!} in step with ${declaration.key}`, () => {
      const stored = storedSample(declaration);

      hydrateSettingValues({ [declaration.wire!]: stored });

      expect(
        (useSettingsStore.getState() as unknown as Record<string, unknown>)[declaration.wire!],
      ).toEqual(stored);
    });
  }

  // A payload omits what it has no value for, and a row is not reset by silence.
  it("leaves a row the payload does not mention where it was", () => {
    hydrateSettingValues({ autoFixCi: true });
    hydrateSettingValues({ liveSteering: false });

    expect(recorded("advanced.autoFixCi")).toBe(true);
  });

  /*
    Silence is the value where the declaration says so (slice 6b). A row marked
    `omitWhenNull` has its field DROPPED from the whole payload rather than sent
    as null, so leaving the record alone would keep showing a pin the server has
    stopped holding. Asserted over whatever carries the mark rather than over the
    one setting that does, since the rule is what a later row inherits.

    **And only for a WHOLE payload.** A message carrying some of the settings
    cannot say a value is gone, only that it does not carry it — found in review,
    where the `global_settings` message, which declares no `nonTurnModel` field at
    all, cleared a pin nobody had touched.
  */
  const OMIT_WHEN_NULL = PAYLOAD_ROWS.filter((d) => d.omitWhenNull);

  it("has a row whose omitted field is a null", () => {
    expect(OMIT_WHEN_NULL.length).toBeGreaterThan(0);
  });

  for (const declaration of OMIT_WHEN_NULL) {
    it(`clears ${declaration.key} when a whole payload drops its field`, () => {
      hydrateSettingValues({ [declaration.wire!]: storedSample(declaration) });
      expect(recorded(declaration.key)).not.toBeNull();

      hydrateSettingValues({ autoFixCi: true });

      expect(recorded(declaration.key)).toBeNull();
    });

    it(`keeps ${declaration.key} when a partial message does not carry it`, () => {
      const stored = storedSample(declaration);
      hydrateSettingValues({ [declaration.wire!]: stored });

      hydrateSettingValues({ autoFixCi: true }, { partial: true });

      expect(recorded(declaration.key)).toEqual(stored);
    });
  }
});

describe("the rows the payload does not carry", () => {
  function answer(body: Record<string, Record<string, unknown>>) {
    const fetchMock = vi.fn((url: string) => Promise.resolve({
      ok: url in body,
      status: url in body ? 200 : 404,
      json: () => Promise.resolve(body[url] ?? {}),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reads each one from the path its declaration names, under its own field", async () => {
    const fetchMock = answer({
      "/api/updates/channel": { channel: "edge" },
      "/api/egress/settings": { globalEnabled: false, enforcementActive: true },
      "/api/voice/webhook": { url: "https://hook.example/notes" },
    });

    await refreshOwnRouteSettings();

    // One read per ADDRESS, not per setting: the two webhook halves share a
    // path, and one answer carries a field each.
    expect(fetchMock.mock.calls.map(([url]) => url).sort())
      .toEqual([...new Set(OWN_ROUTE_SETTINGS.map((d) => ownRouteOf(d)!.path))].sort());
    expect(recorded("advanced.releaseChannel")).toBe("edge");
    expect(recorded("network.egressContained")).toBe(false);
    expect(recorded("voice.webhook.url")).toBe("https://hook.example/notes");
    // Nothing answers the token, so the record keeps the value it had.
    expect(recorded("voice.webhook.token")).toBe("");
  });

  /*
    A read is in flight for as long as a request takes, and a save writes the
    record the moment it is made. The read that started first must not answer
    last and put the old value back under a control the user has since changed —
    the `settings_changed` refresh that would have corrected it has already run.
  */
  it("discards an answer for a value that moved while it was being read", async () => {
    // What the install is on when the read starts, and what the read will answer.
    useSettingsStore.getState().setSettingValue("advanced.releaseChannel", "edge");
    const settlers: ((body: Record<string, unknown>) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      settlers.push((body) => { resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }); });
    })));

    // Both reads are in flight, and the user changes one of the two values.
    const reading = refreshOwnRouteSettings();
    useSettingsStore.getState().setSettingValue("advanced.releaseChannel", "stable");
    for (const settle of settlers) settle({ channel: "edge", globalEnabled: false });
    await reading;

    // The one nobody touched still takes its answer.
    expect(recorded("network.egressContained")).toBe(false);

    expect(recorded("advanced.releaseChannel")).toBe("stable");
  });

  /*
    Every settings refresh starts a read of each address, so two of them overlap
    whenever a `settings_changed` broadcast arrives while one is out. The older
    answer describes the state the address was in first — and left unordered it
    wins twice: it writes the stale value, and that write then makes the newer
    read's own answer look superseded by the moved-underneath guard.
  */
  it("keeps the newer read's answer when an older read lands first", async () => {
    const WEBHOOK = "/api/voice/webhook";
    useSettingsStore.getState().setSettingValue("voice.webhook.url", "https://a.example");
    const pending: { url: string; settle: (body: Record<string, unknown>) => void }[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise((resolve) => {
      pending.push({
        url,
        settle: (body) => {
          resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        },
      });
    })));

    const older = refreshOwnRouteSettings();
    const newer = refreshOwnRouteSettings();
    const webhookReads = pending.filter((p) => p.url === WEBHOOK);
    expect(webhookReads).toHaveLength(2);

    // What the address held when the first read was served, answering after the
    // second read has already been issued.
    webhookReads[0]!.settle({ url: "https://b.example" });
    webhookReads[1]!.settle({ url: "https://c.example" });
    for (const p of pending) p.settle({});
    await Promise.all([older, newer]);

    expect(recorded("voice.webhook.url")).toBe("https://c.example");
  });

  /*
    A failed read keeps the last value ShipIt knew. Answering the declared
    default instead would tell an install tracking `stable` that it is on
    `stable` — a real channel, and possibly the wrong one — which is the same
    mistake `readChannelOutcome` exists to avoid on the server.
  */
  it("keeps the value it had when the route refuses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    answer({ "/api/updates/channel": { channel: "edge" } });
    await refreshOwnRouteSettings();
    answer({});

    await refreshOwnRouteSettings();

    expect(recorded("advanced.releaseChannel")).toBe("edge");
  });

  /*
    A `writeOnly` address stores its value and never answers it, so there is no
    read to pair with the write. Asking anyway would be a 404 on every settings
    refresh — a request that can only ever fail, for a record entry nothing
    could ever fill. The rule is asserted, not the two paths: what must never be
    asked is any address the declarations mark this way.
  */
  it("asks nothing of an address that only stores", async () => {
    const fetchMock = answer({
      "/api/updates/channel": { channel: "edge" },
      "/api/egress/settings": { globalEnabled: false },
      "/api/voice/webhook": { url: "https://hook.example/notes" },
    });

    await refreshOwnRouteSettings();

    const writeOnly = ALL_SETTINGS.filter((d) => ownRouteOf(d)?.writeOnly);
    expect(writeOnly.length).toBeGreaterThan(0);
    const asked = fetchMock.mock.calls.map(([url]) => url);
    for (const declaration of writeOnly) {
      expect(asked, `${declaration.key} has no read to make`)
        .not.toContain(ownRouteOf(declaration)!.path);
      expect(recorded(declaration.key)).toBeUndefined();
    }
  });

  it("keeps it when the answer has no such field", async () => {
    answer({ "/api/updates/channel": { channel: "edge" } });
    await refreshOwnRouteSettings();
    answer({ "/api/updates/channel": { somethingElse: "stable" } });

    await refreshOwnRouteSettings();

    expect(recorded("advanced.releaseChannel")).toBe("edge");
  });
});
