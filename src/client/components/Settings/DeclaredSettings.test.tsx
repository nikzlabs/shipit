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
  it("renders one switch per declaration, and none for a kind it cannot show", () => {
    render(<DeclaredSettings tab="advanced" />);

    expect(screen.getAllByRole("switch")).toHaveLength(ROWS.length);
    for (const declaration of ROWS) {
      const control = screen.getByRole("switch", { name: declaration.label });
      expect(control).toHaveAttribute("data-setting", declaration.key);
    }
    // The memory budget and the release channel stay hand-written in this slice
    // (inventory.md P18), so the generated block must not claim them.
    expect(screen.queryByText(findSetting("advanced.memoryBudgetMb")!.label)).toBeNull();
    expect(screen.queryByText(findSetting("advanced.releaseChannel")!.label)).toBeNull();
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

    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Agent", "Automation", "Conversation", "Notifications"]);

    for (const section of headings) {
      const group = screen.getByRole("region", { name: section! });
      const expected = ROWS.filter((d) => d.section === section).map((d) => d.label);
      expect(within(group).getAllByRole("switch").map((el) => el.getAttribute("aria-label")))
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
  for (const declaration of ROWS.filter((d) => d.store.kind === "credential-store")) {
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

  for (const declaration of ROWS.filter((d) => d.store.kind === "browser")) {
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
