/**
 * Hands-free arms audio inside the click (docs/308-data-driven-settings
 * inventory.md P3).
 *
 * A browser unlocks audio only inside the gesture, so the arming has to happen
 * in the handler rather than after the write — which is the whole reason this
 * toggle is a component and not a generated row. What a test can show is that
 * the call is made, and made before anything is awaited; that the browser then
 * honours it is what the dogfood check is for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VoiceHandsFree } from "./VoiceHandsFree.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { initialSettingValues } from "../../../stores/setting-values.js";
import { settingCopy } from "../setting-copy.js";
import { armAutoplay } from "../../../voice/voice-notes.js";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

vi.mock("../../../voice/voice-notes.js", () => ({ armAutoplay: vi.fn() }));

const KEY = "voice.handsFree" as SettingKey;
const armed = vi.mocked(armAutoplay);

beforeEach(() => { armed.mockReset(); });

afterEach(() => {
  cleanup();
  localStorage.clear();
  useSettingsStore.setState({ settingValues: initialSettingValues(), settingDrafts: {} });
});

const toggle = () => screen.getByRole("switch", { name: settingCopy(KEY).label });

describe("switching hands-free on", () => {
  it("arms autoplay and stores the value under the declaration's key", async () => {
    render(<VoiceHandsFree settingKey={KEY} />);

    await userEvent.click(toggle());

    expect(armed).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().settingValues[KEY]).toBe(true);
    expect(localStorage.getItem("shipit-voice-hands-free")).toBe("true");
  });

  /*
    The gesture is what the browser grants on, so the arming cannot be behind an
    await. Order is what a test can see: moving `armAutoplay()` after the write —
    which is what a generated row would do — puts the store write first.
  */
  it("arms before it writes, so nothing is awaited in between", async () => {
    const order: string[] = [];
    armed.mockImplementation(() => { order.push("armed"); });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key) => {
      if (key === "shipit-voice-hands-free") order.push("stored");
    });
    render(<VoiceHandsFree settingKey={KEY} />);

    await userEvent.click(toggle());

    setItem.mockRestore();
    expect(order).toEqual(["armed", "stored"]);
  });
});

describe("switching hands-free off", () => {
  it("stores the value and arms nothing", async () => {
    useSettingsStore.getState().setSettingValue(KEY, true);
    render(<VoiceHandsFree settingKey={KEY} />);

    await userEvent.click(toggle());

    expect(armed).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settingValues[KEY]).toBe(false);
  });
});
