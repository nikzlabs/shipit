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
import { GENERATED_SETTINGS, OWN_ROUTE_SETTINGS, initialSettingValues, ownRouteOf } from "./setting-values.js";
import { useSettingsStore } from "./settings-store.js";

/** Every generated row the settings payload carries, which is every one with a `wire`. */
const PAYLOAD_ROWS = GENERATED_SETTINGS.filter((d) => d.wire !== undefined);

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
      const stored = declaration.type.kind === "bool"
        ? !declaration.type.defaultValue
        : 4096;

      hydrateSettingValues({ [declaration.wire!]: stored });

      expect(recorded(declaration.key)).toBe(stored);
      // The named field the other 51 read sites use is a view over the record.
      expect(
        (useSettingsStore.getState() as unknown as Record<string, unknown>)[declaration.wire!],
      ).toBe(stored);
    });
  }

  // A payload omits what it has no value for, and a row is not reset by silence.
  it("leaves a row the payload does not mention where it was", () => {
    hydrateSettingValues({ autoFixCi: true });
    hydrateSettingValues({ liveSteering: false });

    expect(recorded("advanced.autoFixCi")).toBe(true);
  });

  // The record's membership is fixed to the generated rows, so a payload field
  // belonging to an unconverted tab cannot seed a value its hydration would
  // never correct (P18).
  it("records nothing for a setting the record does not hold", () => {
    hydrateSettingValues({ autoCreatePr: true });

    expect(recorded("integrations.autoCreatePr")).toBeUndefined();
  });
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
    });

    await refreshOwnRouteSettings();

    expect(fetchMock.mock.calls.map(([url]) => url).sort())
      .toEqual(OWN_ROUTE_SETTINGS.map((d) => ownRouteOf(d)!.path).sort());
    expect(recorded("advanced.releaseChannel")).toBe("edge");
    expect(recorded("network.egressContained")).toBe(false);
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

  it("keeps it when the answer has no such field", async () => {
    answer({ "/api/updates/channel": { channel: "edge" } });
    await refreshOwnRouteSettings();
    answer({ "/api/updates/channel": { somethingElse: "stable" } });

    await refreshOwnRouteSettings();

    expect(recorded("advanced.releaseChannel")).toBe("edge");
  });
});
