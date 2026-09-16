/**
 * The generated rows on the Advanced tab (docs/308-data-driven-settings reqs 1,
 * 2, 11).
 *
 * The expectations are enumerated FROM the catalogue rather than listed, which is
 * what makes req 1 executable: a toggle declared tomorrow is rendered, read and
 * written the day it is declared, and a row that stops saving fails here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeclaredSettings, controlFor } from "./DeclaredSettings.js";
import { resetDeclaredSaves } from "./declared-setting.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { GENERATED_SETTINGS, initialSettingValues } from "../../stores/setting-values.js";
import { findSetting, type SettingKey } from "../../../server/shared/settings-catalogue/index.js";

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
  // The record and the drafts outlive a render, so a test that moves one would
  // otherwise seed the next.
  useSettingsStore.setState({ settingValues: initialSettingValues(), settingDrafts: {} });
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
 * Two lists have to agree: `setting-values.ts` decides which declarations become
 * rows, and the control table decides what a row looks like. A declaration the
 * first admits and the second has no control for renders nothing at all — the
 * row is simply missing, which is what P18 forbids and what no other test here
 * can fail on, because each of those names the rows it expects.
 *
 * It asks the renderer directly rather than looking at rendered DOM: requirement
 * 12 gives up the walk rather than narrowing it, and what is in question is
 * which control a declaration gets, not what that control puts on screen.
 */
describe("every generated row has a control", () => {
  it("finds one for each declaration the reader admits", () => {
    for (const declaration of GENERATED_SETTINGS) {
      expect(
        controlFor(declaration),
        `${declaration.key} is a generated row with no control to edit it`,
      ).toBeTruthy();
    }
  });
});

/**
 * The Instructions tab: prose over the one store whose values are prose.
 *
 * **The store is what makes it a textarea** — the design rejected a
 * `presentation: "multiline"` field because `system-prompt-file` already says
 * it, and this is that rule at the control.
 */
describe("the instruction boxes", () => {
  const BOXES = ["instructions.userInstructions", "instructions.opsInstructions"] as const;

  it("renders a textarea for each prompt-file row, named by its declaration", () => {
    render(<DeclaredSettings tab="instructions" />);

    for (const key of BOXES) {
      const declaration = findSetting(key)!;
      const box = screen.getByRole("textbox", { name: declaration.label });
      expect(box.tagName).toBe("TEXTAREA");
      expect(box).toHaveAttribute("data-setting", key);
    }
  });

  it("counts what is typed against the declared maximum", async () => {
    render(<DeclaredSettings tab="instructions" />);

    await userEvent.type(screen.getByRole("textbox", { name: "Your Instructions" }), "abc");

    expect(screen.getAllByText("3 / 50,000")).toHaveLength(1);
  });

  // P8 — the refusal is the value type's own, which is the text the agent is
  // shown for the same write.
  it("shows the value type's own refusal when the draft is too long", () => {
    render(<DeclaredSettings tab="instructions" />);
    const box = screen.getByRole("textbox", { name: "Your Instructions" });

    fireEvent.change(box, { target: { value: "x".repeat(50_001) } });

    expect(screen.getByText("System prompt is too long (max 50,000 characters)")).toBeInTheDocument();
  });

  // The toggle beside them is an ordinary declared boolean, so it needs nothing
  // of its own — but the tab has to actually render it.
  it("renders the built-in instructions toggle as a plain declared switch", () => {
    render(<DeclaredSettings tab="instructions" />);

    const declaration = findSetting("instructions.agentInstructionsEnabled")!;
    expect(screen.getByRole("switch", { name: declaration.label }))
      .toHaveAttribute("data-setting", declaration.key);
  });
});

/**
 * The Git tab: a name and an email are ONE setting, because they are written
 * together (inventory.md P9). The value kind carries the control, so this is a
 * table entry rather than a component.
 */
describe("the git identity", () => {
  const KEY = "git.identity" as SettingKey;

  function seed(identity: { name: string; email: string }) {
    useSettingsStore.getState().setSettingValue(KEY, identity);
  }

  it("shows the stored name and email in two boxes over one declaration", () => {
    seed({ name: "Ada", email: "ada@example.com" });
    const { container } = render(<DeclaredSettings tab="git" />);

    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
    expect(container.querySelectorAll('[data-setting="git.identity"]')).toHaveLength(2);
  });

  it("edits one half without discarding the other", () => {
    seed({ name: "Ada", email: "ada@example.com" });
    render(<DeclaredSettings tab="git" />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grace" } });

    expect(useSettingsStore.getState().settingDrafts[KEY]?.value)
      .toEqual({ name: "Grace", email: "ada@example.com" });
    // Nothing is stored until the tab's Save commits it.
    expect(settingValue(KEY)).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("shows the value type's own refusal for a half-filled identity", () => {
    seed({ name: "Ada", email: "ada@example.com" });
    render(<DeclaredSettings tab="git" />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "" } });

    expect(screen.getByText("Git email cannot be empty")).toBeInTheDocument();
  });
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
