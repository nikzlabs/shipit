/**
 * The generated rows on the Advanced tab (docs/308-data-driven-settings reqs 1,
 * 2, 11).
 *
 * The expectations are enumerated FROM the catalogue rather than listed, which is
 * what makes req 1 executable: a toggle declared tomorrow is rendered, read and
 * written the day it is declared, and a row that stops saving fails here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeclaredSettings } from "./DeclaredSettings.js";
import { resetDeclaredSaves } from "./declared-setting.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { GENERATED_SETTINGS } from "../../stores/setting-values.js";
import { findSetting } from "../../../server/shared/settings-catalogue/index.js";

const ROWS = GENERATED_SETTINGS.filter((d) => d.tab === "advanced");
/** The rows a value kind's own control renders — everything but the components. */
const TOGGLES = ROWS.filter((d) => d.type.kind === "bool" && !d.component);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  resetDeclaredSaves();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function settingValue(key: string): unknown {
  return useSettingsStore.getState().settingValues[key];
}

describe("the Advanced tab's rows come from the declarations", () => {
  it("renders one switch per declared boolean", () => {
    render(<DeclaredSettings tab="advanced" />);

    expect(screen.getAllByRole("switch")).toHaveLength(TOGGLES.length);
    for (const declaration of TOGGLES) {
      const control = screen.getByRole("switch", { name: declaration.label });
      expect(control).toHaveAttribute("data-setting", declaration.key);
    }
  });

  // The control a value kind gets, for the one enum on this tab: a card per
  // option, each carrying that option's own declared description.
  it("renders a choice as one card per declared option", () => {
    render(<DeclaredSettings tab="advanced" />);

    const declaration = findSetting("advanced.releaseChannel")!;
    for (const option of (declaration.type.shape as { options: { label: string; description: string }[] }).options) {
      const card = screen.getByRole("button", { name: option.label });
      expect(card).toHaveAttribute("data-setting", declaration.key);
      expect(card).toHaveTextContent(option.description);
    }
  });

  // req 3 — a setting whose editing needs its own logic is still a declared row:
  // the block renders the component the declaration names, in its place.
  it("renders a declaration's component in place of a generated control", () => {
    render(<DeclaredSettings tab="advanced" />);

    expect(screen.getByTestId("settings-memory-budget")).toHaveAttribute(
      "data-setting",
      "advanced.memoryBudgetMb",
    );
  });

  it("shows each row's declared label and description, and nothing of its own", () => {
    const { container } = render(<DeclaredSettings tab="advanced" />);

    for (const declaration of ROWS) {
      expect(
        container.querySelector(`[data-setting-label="${declaration.key}"]`),
      ).toHaveTextContent(declaration.label);
      expect(
        container.querySelector(`[data-setting-description="${declaration.key}"]`),
      ).toHaveTextContent(declaration.description);
    }
  });

  it("groups rows under their declared section, in declaration order", () => {
    render(<DeclaredSettings tab="advanced" />);

    // A group whose declarations carry no section — the memory budget — has no
    // heading and so is not a named region; it renders between the two that do.
    const sections = screen.getAllByRole("region").map((el) => el.getAttribute("aria-label"));
    expect(sections).toEqual([
      "Software Updates", "Agent", "Automation", "Conversation", "Notifications",
    ]);

    for (const section of sections) {
      const group = screen.getByRole("region", { name: section! });
      const expected = TOGGLES.filter((d) => d.section === section).map((d) => d.label);
      expect(within(group).queryAllByRole("switch").map((el) => el.getAttribute("aria-label")))
        .toEqual(expected);
    }
  });

  it("places a section's own prose inside that section", () => {
    render(
      <DeclaredSettings tab="advanced" notes={{ Notifications: <p>Only when you are away.</p> }} />,
    );

    const group = screen.getByRole("region", { name: "Notifications" });
    expect(within(group).getByText("Only when you are away.")).toBeInTheDocument();
  });
});

describe("a generated row writes where its declaration says", () => {
  for (const declaration of TOGGLES.filter((d) => d.store.kind === "credential-store")) {
    it(`saves ${declaration.key} to its declared payload field`, async () => {
      render(<DeclaredSettings tab="advanced" />);
      const control = screen.getByRole("switch", { name: declaration.label });
      const next = control.getAttribute("aria-checked") !== "true";

      await userEvent.click(control);

      const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toBe("/api/settings");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ [declaration.wire!]: next });
      expect(settingValue(declaration.key)).toBe(next);
      // The named field the rest of the app reads is a view over the record.
      expect(
        (useSettingsStore.getState() as unknown as Record<string, unknown>)[declaration.wire!],
      ).toBe(next);
    });
  }

  for (const declaration of TOGGLES.filter((d) => d.store.kind === "browser")) {
    const storageKey = (declaration.store as { localStorageKey: string }).localStorageKey;

    it(`saves ${declaration.key} to ${storageKey} and asks the server nothing`, async () => {
      render(<DeclaredSettings tab="advanced" />);
      const control = screen.getByRole("switch", { name: declaration.label });
      const next = control.getAttribute("aria-checked") !== "true";

      await userEvent.click(control);

      expect(localStorage.getItem(storageKey)).toBe(String(next));
      expect(settingValue(declaration.key)).toBe(next);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(control).toHaveAttribute("aria-checked", String(next));
    });
  }
});

/**
 * The Network tab's one generated row, and the store shape that makes it one
 * (inventory.md P2): the declaration carries the method, the path and the body
 * field, so a setting the settings payload does not hold is a row like any
 * other.
 */
describe("a row stored behind a route of its own", () => {
  it("writes the declared method, path and body field", async () => {
    render(<DeclaredSettings tab="network" />);
    const declaration = findSetting("network.egressContained")!;
    const control = screen.getByRole("switch", { name: declaration.label });

    await userEvent.click(control);

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/egress/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ globalEnabled: false });
    expect(settingValue("network.egressContained")).toBe(false);
  });

  // The two own-route settings post DIFFERENT body shapes, which is the whole
  // reason the store carries a field name rather than a route sentence.
  it("posts each own-route setting under its own field name", async () => {
    render(<DeclaredSettings tab="advanced" />);

    await userEvent.click(screen.getByRole("button", { name: "Edge" }));

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("/api/updates/channel");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ channel: "edge" });
  });
});
