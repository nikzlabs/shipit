/**
 * Provider, voice and speed as one control (docs/308-data-driven-settings
 * inventory.md P3 and P7, req 3).
 *
 * The repair is why they are one component, so that is what is under test — and
 * what it must NOT have changed is where each value goes: every write still
 * lands on the storage key its own declaration names.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VoiceTts } from "./VoiceTts.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useVoiceKeyStatus } from "../../../voice/voice-key-status.js";
import { initialSettingValues } from "../../../stores/setting-values.js";
import { settingCopy } from "../setting-copy.js";
import { providerVoices } from "../../../../server/shared/voice-catalog.js";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

const PROVIDER = "voice.ttsProvider" as SettingKey;
const VOICE = "voice.ttsVoice" as SettingKey;
const SPEED = "voice.ttsSpeed" as SettingKey;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  useSettingsStore.setState({ settingValues: initialSettingValues(), settingDrafts: {} });
  useVoiceKeyStatus.setState({ configured: [] });
});

function seed(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    useSettingsStore.getState().setSettingValue(key as SettingKey, value);
  }
}

const providerSelect = () => screen.getByRole("combobox", { name: settingCopy(PROVIDER).label });
const voiceSelect = () => screen.getByRole("combobox", { name: settingCopy(VOICE).label });
const stored = (key: SettingKey) => useSettingsStore.getState().settingValues[key];

describe("changing the text-to-speech provider repairs what depends on it", () => {
  it("re-picks a voice the new provider does not have", () => {
    seed({ [PROVIDER]: "openai", [VOICE]: "alloy", [SPEED]: 1 });
    render(<VoiceTts />);

    fireEvent.change(providerSelect(), { target: { value: "elevenlabs" } });

    expect(stored(PROVIDER)).toBe("elevenlabs");
    expect(stored(VOICE)).toBe(providerVoices("elevenlabs")[0]!.id);
    expect(localStorage.getItem("shipit-tts-voice")).toBe(providerVoices("elevenlabs")[0]!.id);
  });

  it("re-picks a speed the new provider does not offer", () => {
    seed({ [PROVIDER]: "openai", [VOICE]: "alloy", [SPEED]: 2 });
    render(<VoiceTts />);

    fireEvent.change(providerSelect(), { target: { value: "elevenlabs" } });

    // ElevenLabs tops out at 1.2×, and 1 is among its speeds, so that is the one.
    expect(stored(SPEED)).toBe(1);
    expect(localStorage.getItem("shipit-tts-speed")).toBe("1");
  });

  it("leaves a speed the new provider does offer alone", () => {
    seed({ [PROVIDER]: "openai", [VOICE]: "alloy", [SPEED]: 1 });
    render(<VoiceTts />);

    fireEvent.change(providerSelect(), { target: { value: "elevenlabs" } });

    expect(stored(SPEED)).toBe(1);
  });

  it("writes each value to the storage key its own declaration names", () => {
    seed({ [PROVIDER]: "openai", [VOICE]: "alloy", [SPEED]: 1 });
    render(<VoiceTts />);

    fireEvent.change(providerSelect(), { target: { value: "elevenlabs" } });

    expect(localStorage.getItem("shipit-tts-provider")).toBe("elevenlabs");
    expect(localStorage.getItem("shipit-tts-voice")).toBe(providerVoices("elevenlabs")[0]!.id);
  });
});

describe("the voices and speeds on offer come from the provider", () => {
  it("offers exactly the chosen provider's voices", () => {
    seed({ [PROVIDER]: "elevenlabs", [VOICE]: providerVoices("elevenlabs")[0]!.id });
    render(<VoiceTts />);

    const rendered = [...(voiceSelect() as HTMLSelectElement).options].map((o) => o.value);
    expect(rendered).toEqual(providerVoices("elevenlabs").map((v) => v.id));
  });

  it("stores a speed on click, under the declaration's own key", () => {
    seed({ [PROVIDER]: "openai", [VOICE]: "alloy", [SPEED]: 1 });
    render(<VoiceTts />);

    fireEvent.click(screen.getByRole("button", { name: "Playback speed 1.5×" }));

    expect(stored(SPEED)).toBe(1.5);
    expect(localStorage.getItem("shipit-tts-speed")).toBe("1.5");
  });
});

describe("a provider with no key stored", () => {
  it("says a key is needed and offers no test", () => {
    seed({ [PROVIDER]: "openai" });
    render(<VoiceTts />);

    expect(screen.getByText(/Add a OpenAI key above/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test playback" })).toBeDisabled();
  });

  it("drops the line and offers the test once the key is stored", () => {
    seed({ [PROVIDER]: "openai" });
    useVoiceKeyStatus.setState({ configured: ["openai"] });
    render(<VoiceTts />);

    expect(screen.queryByText(/Add a OpenAI key above/)).toBeNull();
    expect(screen.getByRole("button", { name: "Test playback" })).not.toBeDisabled();
  });
});
