/**
 * The save wiring a declaration generates (docs/299-agent-settings-access req 7,
 * plan.md → Settings are declared once).
 *
 * The cases are enumerated FROM the catalogue rather than listed here, which is
 * what makes this req 7 executable on the client side: a boolean declared
 * tomorrow is covered the day it is declared, and one whose browser-store field
 * or setter is missing fails here as well as at compile time — `writeStore`
 * silently finds nothing to call, so the optimistic value never lands.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeclaredToggle } from "./declared.js";
import {
  resetDeclaredSaves,
  saveDeclaredBoolean,
  type DeclaredBooleanKey,
} from "./declared-setting.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import {
  GLOBAL_SETTINGS,
  findSetting,
  type AnyPayloadDeclaration,
} from "../../../server/shared/settings-catalogue/index.js";

/**
 * Every declared boolean the global payload stores — the runtime twin of
 * `DeclaredBooleanKey`, which the type system computes from the same two facts.
 */
const DERIVED = (Object.values(GLOBAL_SETTINGS) as AnyPayloadDeclaration[]).filter(
  (d) => d.store.kind === "credential-store" && d.type.kind === "bool",
);

function storeValue(wire: string): boolean {
  return (useSettingsStore.getState() as unknown as Record<string, boolean>)[wire];
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  resetDeclaredSaves();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUiStore.getState().setToast(null);
});

describe("a declared boolean saves itself", () => {
  it("covers every boolean the global payload stores", () => {
    // A guard against the list above quietly emptying: the derivation is only
    // worth anything if it actually applies to the dialog's toggles.
    expect(DERIVED.length).toBeGreaterThan(5);
  });

  for (const declaration of DERIVED) {
    const key = declaration.key as DeclaredBooleanKey;
    const wire = declaration.wire;

    it(`writes ${key} to the browser store and to its declared payload field`, async () => {
      const next = !storeValue(wire);
      await act(async () => { await saveDeclaredBoolean(key, next); });

      expect(storeValue(wire)).toBe(next);
      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toBe("/api/settings");
      expect(init.method).toBe("PUT");
      // Exactly the one field, named by the declaration: a save carries only
      // what changed, and nothing here knows the field by any other route.
      expect(JSON.parse(init.body)).toEqual({ [wire]: next });
    });

    it(`puts ${key} back and names it when the save does not land`, async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const before = storeValue(wire);

      await act(async () => { await saveDeclaredBoolean(key, !before); });

      expect(storeValue(wire)).toBe(before);
      // The declaration's own label, so the toast names the control the user
      // just used rather than a second phrasing written beside the fetch.
      expect(useUiStore.getState().toast?.message).toBe(
        `Failed to update ${declaration.label}`,
      );
    });
  }
});

/**
 * A toggle is one click, so two of them overlap the moment the user changes
 * their mind. These hold both requests pending on purpose: a test that awaits
 * each save in turn never has two in flight, and passes with the defect present.
 */
describe("two saves of one setting that overlap", () => {
  const KEY = "advanced.enableSubAgents" as DeclaredBooleanKey;
  const WIRE = "enableSubAgents";

  /** A fetch whose responses are settled by hand, in whatever order the test wants. */
  function deferredFetch(): ((ok: boolean) => void)[] {
    const settlers: ((ok: boolean) => void)[] = [];
    fetchMock.mockImplementation(
      () => new Promise((resolve) => {
        settlers.push((ok) => { resolve({ ok, status: ok ? 200 : 500 }); });
      }),
    );
    return settlers;
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useSettingsStore.getState().setEnableSubAgents(true);
  });

  it("shows the server's value when both fail, not the reverse of the later one", async () => {
    const settlers = deferredFetch();
    const off = saveDeclaredBoolean(KEY, false);
    const on = saveDeclaredBoolean(KEY, true);
    expect(settlers).toHaveLength(2);

    await act(async () => { settlers[0](false); await off; });
    await act(async () => { settlers[1](false); await on; });

    // The server was never written to, so it is still on. Reverting each save to
    // the opposite of its OWN requested value leaves this off.
    expect(storeValue(WIRE)).toBe(true);
  });

  it("does not let an older request's failure flip the switch under a newer one", async () => {
    const settlers = deferredFetch();
    const first = saveDeclaredBoolean(KEY, false);
    const second = saveDeclaredBoolean(KEY, true);
    const third = saveDeclaredBoolean(KEY, false);

    await act(async () => { settlers[1](true); await second; });
    // The first request fails while the user's most recent click is still in
    // flight. A rollback here corrects a display the newest request owns, and
    // the switch jumps to on with nothing left to put it back.
    await act(async () => { settlers[0](false); await first; });
    await act(async () => { settlers[2](true); await third; });

    expect(storeValue(WIRE)).toBe(false);
  });

  it("rolls back to a value that moved underneath it, not to the one it remembered", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await act(async () => { await saveDeclaredBoolean(KEY, true); });

    // A `settings_changed` refetch, or another viewer's save: nothing is in
    // flight, so the displayed value is the server's and the remembered one is
    // stale.
    act(() => { useSettingsStore.getState().setEnableSubAgents(false); });

    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await act(async () => { await saveDeclaredBoolean(KEY, true); });

    expect(storeValue(WIRE)).toBe(false);
  });
});

describe("a toggle given no wiring is still a working control", () => {
  it("renders the declared value and saves the change", async () => {
    const before = storeValue("enableSubAgents");
    render(<DeclaredToggle settingKey="advanced.enableSubAgents" />);

    const control = screen.getByRole("switch", {
      name: GLOBAL_SETTINGS["advanced.enableSubAgents"].label,
    });
    expect(control).toHaveAttribute("aria-checked", String(before));

    await userEvent.click(control);

    expect(storeValue("enableSubAgents")).toBe(!before);
    expect(control).toHaveAttribute("aria-checked", String(!before));
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ enableSubAgents: !before });
  });

  it("still takes wiring of its own, for a value the server does not hold", async () => {
    const onToggle = vi.fn();
    // A browser-local value: there is no payload field to derive, so the two
    // props stay, and supplying them must not reach `PUT /api/settings`.
    render(
      <DeclaredToggle
        settingKey="advanced.compactConversation"
        enabled={false}
        onToggle={onToggle}
      />,
    );

    await userEvent.click(
      screen.getByRole("switch", { name: findSetting("advanced.compactConversation")!.label }),
    );
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
