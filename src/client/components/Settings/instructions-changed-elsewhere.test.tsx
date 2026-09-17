import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Settings, type SettingsProps } from "./Settings.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { initialSettingValues } from "../../stores/setting-values.js";
import type { SettingKey } from "../../../server/shared/settings-catalogue/index.js";

/**
 * An editor with unsaved edits keeps its draft and says the underlying value
 * changed (docs/299-agent-settings-access, plan.md → Apply goes through a shared
 * layer; docs/308-data-driven-settings inventory.md P14).
 *
 * Keeping the draft is the easy half: it lives in the draft record, which a
 * hydration does not touch. Saying so is the point — without it, Save silently
 * reverts a change the user never saw. What makes the two states tellable apart
 * is the seed the draft started from, so these drive the RECORD, which is where
 * an applied proposal or another tab's write lands.
 */

const props: SettingsProps = {
  agentList: [],
  onClose: vi.fn(),
};

const USER = "instructions.userInstructions";
const OPS = "instructions.opsInstructions";

afterEach(() => {
  cleanup();
  useUiStore.getState().setSettingsTab(undefined);
  useSettingsStore.setState({ settingValues: initialSettingValues(), settingDrafts: {} });
});

/** What a refetch does after another tab, or an applied proposal, saved. */
function storedValueBecomes(key: string, value: string) {
  act(() => { useSettingsStore.getState().setSettingValue(key as SettingKey, value); });
}

function openInstructions(stored: Partial<Record<string, string>> = {}) {
  for (const [key, value] of Object.entries(stored)) {
    useSettingsStore.getState().setSettingValue(key as SettingKey, value);
  }
  useUiStore.getState().setSettingsTab("instructions");
  render(<Settings {...props} />);
}

const box = (name: string) => screen.getByRole("textbox", { name });
const notice = (key: string) => screen.queryByTestId(`setting-changed-elsewhere-${key}`);

describe("the instructions editor, when the stored value moves underneath it", () => {
  it("adopts the new value in an untouched box, rather than writing a stale one back", () => {
    openInstructions({ [USER]: "Be brief." });

    storedValueBecomes(USER, "Be brief and cite files.");

    expect(box("Your Instructions")).toHaveValue("Be brief and cite files.");
    expect(notice(USER)).not.toBeInTheDocument();
  });

  it("says nothing for an unsaved draft while the stored value has not moved", () => {
    openInstructions({ [USER]: "Be brief." });

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });

    expect(notice(USER)).not.toBeInTheDocument();
  });

  it("keeps the draft and says the value changed when both are true", () => {
    openInstructions({ [USER]: "Be brief." });
    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });

    storedValueBecomes(USER, "Cite every file.");

    expect(notice(USER)).toBeInTheDocument();
    expect(box("Your Instructions")).toHaveValue("Be brief. Always.");
  });

  /*
    A box that has been typed in keeps showing what was typed, even when that
    happens to be what it started from — and the next edit still works.

    Dropping the draft there looked tidier and lost keystrokes: the dropped
    draft left its seed behind, so after the stored value moved, the following
    edit was compared against a value nobody was looking at and vanished. A
    draft now lives from the first keystroke until the write that carries it
    lands, or until the dialog closes.
  */
  it("keeps what was typed after a revert, and keeps taking edits", () => {
    openInstructions({ [USER]: "Be brief." });
    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });
    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief." } });

    storedValueBecomes(USER, "Cite every file.");
    expect(box("Your Instructions")).toHaveValue("Be brief.");
    expect(notice(USER)).toBeInTheDocument();

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. And cite." } });
    expect(box("Your Instructions")).toHaveValue("Be brief. And cite.");
  });

  it("says it for the ops instructions, and about that box alone", () => {
    openInstructions({ [USER]: "Be brief.", [OPS]: "Report a timeline." });
    fireEvent.change(box("Ops Session Instructions"), { target: { value: "Report a timeline. Always." } });

    storedValueBecomes(OPS, "Name the evidence.");

    expect(notice(OPS)).toBeInTheDocument();
    expect(notice(USER)).not.toBeInTheDocument();
    expect(box("Ops Session Instructions")).toHaveValue("Report a timeline. Always.");
  });
});
