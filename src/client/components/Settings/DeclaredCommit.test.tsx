/**
 * The tab-level Save (docs/308-data-driven-settings req 1, inventory.md P5,
 * P14).
 *
 * What it commits comes from the drafts on the tab, so the guarantee the
 * catalogue's `instructions.commit` exclusion states — both boxes in ONE write —
 * is a property of the button rather than of the two settings it happens to
 * cover today. What it may commit comes from each value type's `validate()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitTab } from "./tabs/GitTab.js";
import { InstructionsTab } from "./tabs/InstructionsTab.js";
import { commitSettings } from "./declared-setting.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { initialSettingValues } from "../../stores/setting-values.js";
import type { SettingKey } from "../../../server/shared/settings-catalogue/index.js";

const USER = "instructions.userInstructions" as SettingKey;
const OPS = "instructions.opsInstructions" as SettingKey;
const IDENTITY = "git.identity" as SettingKey;

let fetchMock: ReturnType<typeof vi.fn>;

/** The route answers with the settings it stored, which is what the record takes. */
function answersWith(stored: Record<string, unknown>) {
  fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(stored) });
}

beforeEach(() => {
  // The real route answers with the settings payload it stored, so the default
  // echoes the body: a test that wants the stored value to DIFFER from the sent
  // one says so with `answersWith`.
  fetchMock = vi.fn((_url: string, init: { body: string }) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(JSON.parse(init.body) as Record<string, unknown>),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settingValues: initialSettingValues(), settingDrafts: {} });
  useUiStore.getState().setToast(null);
});

function seed(values: Partial<Record<string, unknown>>) {
  for (const [key, value] of Object.entries(values)) {
    useSettingsStore.getState().setSettingValue(key as SettingKey, value);
  }
}

const save = () => screen.getByRole("button", { name: /^Save/ });
const box = (name: string) => screen.getByRole("textbox", { name });
const bodyOf = (call: number) =>
  JSON.parse((fetchMock.mock.calls[call] as [string, { body: string }])[1].body) as unknown;

describe("the Instructions tab's Save", () => {
  it("is disabled while nothing has been edited", () => {
    seed({ [USER]: "Be brief." });
    render(<InstructionsTab onClose={vi.fn()} />);

    expect(save()).toBeDisabled();
  });

  it("commits every edited box on the tab in one write", async () => {
    seed({ [USER]: "Be brief.", [OPS]: "Report a timeline." });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });
    fireEvent.change(box("Ops Session Instructions"), { target: { value: "Name the evidence." } });
    await userEvent.click(save());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PUT");
    expect(bodyOf(0)).toEqual({
      systemPrompt: "Be brief. Always.",
      systemPromptOps: "Name the evidence.",
    });
  });

  it("sends only what was edited, leaving the other box's field out", async () => {
    seed({ [USER]: "Be brief.", [OPS]: "Report a timeline." });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Ops Session Instructions"), { target: { value: "Name the evidence." } });
    await userEvent.click(save());

    expect(bodyOf(0)).toEqual({ systemPromptOps: "Name the evidence." });
  });

  // The writers trim, so the value that was sent is not always the value that
  // is now stored — the record takes what the server echoed back.
  it("records the value the server stored, not the one that was sent", async () => {
    answersWith({ systemPrompt: "Be brief." });
    seed({ [USER]: "" });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief.\n\n" } });
    await userEvent.click(save());

    await waitFor(() => {
      expect(useSettingsStore.getState().settingValues[USER]).toBe("Be brief.");
    });
    expect(box("Your Instructions")).toHaveValue("Be brief.");
  });

  it("keeps the draft and says so when the write does not land", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    seed({ [USER]: "Be brief." });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });
    await userEvent.click(save());

    await waitFor(() => {
      expect(useUiStore.getState().toast?.message).toBe("Failed to save Your Instructions");
    });
    expect(box("Your Instructions")).toHaveValue("Be brief. Always.");
    expect(useSettingsStore.getState().settingValues[USER]).toBe("Be brief.");
    expect(save().textContent).toBe("Save");
  });

  // A save is a round trip, and the user can keep typing across it. Clearing the
  // draft on the answer would put the stored value back under what they typed.
  it("keeps an edit made while the write was in flight", async () => {
    let answer: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => {
      answer = () => { resolve({ ok: true, json: () => Promise.resolve({ systemPrompt: "Be brief. Always." }) }); };
    }));
    seed({ [USER]: "Be brief." });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });
    await userEvent.click(save());
    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always. And cite." } });
    answer(undefined);

    await waitFor(() => {
      expect(useSettingsStore.getState().settingValues[USER]).toBe("Be brief. Always.");
    });
    expect(box("Your Instructions")).toHaveValue("Be brief. Always. And cite.");
  });

  /*
    The one case a value comparison alone gets wrong: what the user typed while
    the write was in flight happens to be what the box held before it. Settling
    on "the draft still equals what was sent" keeps it; dropping the draft
    because it matches the stored value would show them the saved text instead.
  */
  it("keeps an in-flight edit that returns to the value the box started from", async () => {
    let answer = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => {
      answer = () => { resolve({ ok: true, json: () => Promise.resolve({ systemPrompt: "Be brief. Always." }) }); };
    }));
    seed({ [USER]: "Be brief." });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });
    await userEvent.click(save());
    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief." } });
    answer();

    await waitFor(() => {
      expect(useSettingsStore.getState().settingValues[USER]).toBe("Be brief. Always.");
    });
    expect(box("Your Instructions")).toHaveValue("Be brief.");
    // And the write that moved the stored value was the user's own, so the box
    // must not report it as a change from somewhere else.
    expect(screen.queryByTestId(`setting-changed-elsewhere-${USER}`)).not.toBeInTheDocument();
  });

  // Nothing sequences two commits of the same setting, so the button is the
  // thing that stops them overlapping: out-of-order responses would otherwise
  // leave the record on the older value with the server holding the newer.
  it("refuses a second commit while the first is in flight", async () => {
    let answer = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => {
      answer = () => { resolve({ ok: true, json: () => Promise.resolve({ systemPrompt: "one" }) }); };
    }));
    seed({ [USER]: "Be brief." });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "one" } });
    await userEvent.click(save());
    fireEvent.change(box("Your Instructions"), { target: { value: "two" } });

    expect(save()).toBeDisabled();
    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => { expect(save()).toBeEnabled(); });
  });

  it("says Saved until the next edit", async () => {
    seed({ [USER]: "Be brief." });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });
    await userEvent.click(save());
    await waitFor(() => { expect(save().textContent).toBe("Saved"); });

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always. Please." } });
    expect(save().textContent).toBe("Save");
  });

  it("commits on Ctrl+Enter too", async () => {
    seed({ [USER]: "Be brief." });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });
    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    expect(bodyOf(0)).toEqual({ systemPrompt: "Be brief. Always." });
  });

  // The bounds live in the value type, so the keyboard path cannot enforce a
  // different limit from the button (inventory.md P8).
  it("refuses a draft the value type refuses, from either path", async () => {
    seed({ [USER]: "Be brief." });
    render(<InstructionsTab onClose={vi.fn()} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "x".repeat(50_001) } });

    expect(save()).toBeDisabled();
    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes the dialog on Cancel, without writing anything", async () => {
    const onClose = vi.fn();
    seed({ [USER]: "Be brief." });
    render(<InstructionsTab onClose={onClose} />);

    fireEvent.change(box("Your Instructions"), { target: { value: "Be brief. Always." } });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The same button on another tab, over a store that is not the credential
 * store: the git config reaches `PUT /api/settings` under the declaration's own
 * `wire`, like every other payload setting.
 */
describe("the Git tab's Save", () => {
  it("writes the identity to its declared payload field", async () => {
    seed({ [IDENTITY]: { name: "Ada", email: "ada@example.com" } });
    render(<GitTab />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Grace  " } });
    await userEvent.click(screen.getByRole("button", { name: /^Save/ }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)).toEqual({
      gitIdentity: { name: "  Grace  ", email: "ada@example.com" },
    });
  });

  it("refuses to commit half an identity", () => {
    seed({ [IDENTITY]: { name: "Ada", email: "ada@example.com" } });
    render(<GitTab />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "" } });

    expect(screen.getByRole("button", { name: /^Save/ })).toBeDisabled();
  });
});

/**
 * `commitSettings` takes its **destination from the declarations**, and every
 * entry has to share it (plan.md → Slices → 4). That is what lets the voice
 * webhook's two halves be one write to their shared address while the two
 * instruction boxes stay one write to the settings payload — a caller names keys
 * and never a path.
 */
describe("a commit whose destination is not the settings payload", () => {
  const WEBHOOK_URL = "voice.webhook.url" as SettingKey;
  const WEBHOOK_TOKEN = "voice.webhook.token" as SettingKey;

  it("sends one request to the address both declarations name", async () => {
    await commitSettings([[WEBHOOK_URL, "https://hook.example/notes"], [WEBHOOK_TOKEN, "s3cret"]]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(url).toBe("/api/voice/webhook");
    expect(init.method).toBe("POST");
    expect(bodyOf(0)).toEqual({ url: "https://hook.example/notes", token: "s3cret" });
  });

  /*
    Nothing commits across two destinations today, so nothing fans out — a caller
    that mixes them is a mistake, and saying so by name beats splitting the write
    silently or posting one setting to the other's route.
  */
  it("refuses to commit settings stored in two different places", async () => {
    await expect(commitSettings([[USER, "Be brief."], [WEBHOOK_URL, "https://hook.example/notes"]]))
      .rejects.toThrow(/different destinations/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /*
    The webhook token is write-only: `configuredOnly` says so, and the route that
    stored it answers the url alone. A record that took `undefined` for the
    missing field would be inventing a value for a secret the browser may not
    read back.
  */
  it("leaves a write-only half out of the record while the echoed half moves", async () => {
    answersWith({ url: "https://hook.example/notes" });

    await commitSettings([[WEBHOOK_URL, "https://hook.example/notes"], [WEBHOOK_TOKEN, "s3cret"]]);

    const values = useSettingsStore.getState().settingValues;
    expect(values[WEBHOOK_URL]).toBe("https://hook.example/notes");
    expect(values[WEBHOOK_TOKEN]).toBe("");
  });
});
