/**
 * Tests for the shared voice provider catalog (docs/144).
 *
 * The catalog is the single source of truth both layers import, so these
 * assertions pin the selectors that drive Settings dropdowns and server-side
 * validation. Pure data — no mocks needed.
 */

import { describe, it, expect } from "vitest";
import {
  VOICE_PROVIDERS,
  getVoiceProvider,
  sttProviders,
  ttsProviders,
  keyRequiringProviders,
  providerVoices,
  providerSupports,
  isValidVoice,
  defaultVoiceFor,
  providerSpeeds,
} from "./voice-catalog.js";

describe("getVoiceProvider", () => {
  it("returns the entry for a known id", () => {
    expect(getVoiceProvider("openai")?.label).toBe("OpenAI");
  });
  it("returns undefined for an unknown id", () => {
    expect(getVoiceProvider("bogus")).toBeUndefined();
  });
});

describe("capability selectors", () => {
  it("sttProviders includes openai and deepgram but not elevenlabs", () => {
    const ids = sttProviders().map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("deepgram");
    expect(ids).not.toContain("elevenlabs");
  });
  it("ttsProviders includes openai and elevenlabs but not deepgram", () => {
    const ids = ttsProviders().map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("elevenlabs");
    expect(ids).not.toContain("deepgram");
  });
  it("providerSupports reflects the capability array", () => {
    expect(providerSupports("openai", "cleanup")).toBe(true);
    expect(providerSupports("elevenlabs", "stt")).toBe(false);
    expect(providerSupports("deepgram", "tts")).toBe(false);
    expect(providerSupports("bogus", "stt")).toBe(false);
  });
});

describe("keyRequiringProviders", () => {
  it("returns every provider that needs a server-side key", () => {
    const ids = keyRequiringProviders().map((p) => p.id);
    expect(ids).toEqual(VOICE_PROVIDERS.filter((p) => p.requiresKey).map((p) => p.id));
    expect(ids).toContain("openai");
    expect(ids).toContain("elevenlabs");
    expect(ids).toContain("deepgram");
  });
});

describe("voice helpers", () => {
  it("providerVoices returns the provider's voices, [] for none", () => {
    expect(providerVoices("openai").length).toBeGreaterThan(0);
    expect(providerVoices("deepgram")).toEqual([]);
    expect(providerVoices("bogus")).toEqual([]);
  });
  it("isValidVoice only accepts voices that belong to the provider", () => {
    expect(isValidVoice("openai", "alloy")).toBe(true);
    // ElevenLabs voice id is invalid for OpenAI.
    expect(isValidVoice("openai", "21m00Tcm4TlvDq8ikWAM")).toBe(false);
    expect(isValidVoice("elevenlabs", "21m00Tcm4TlvDq8ikWAM")).toBe(true);
    expect(isValidVoice("deepgram", "alloy")).toBe(false);
  });
  it("defaultVoiceFor returns the first voice, '' for none", () => {
    expect(defaultVoiceFor("openai")).toBe("alloy");
    expect(defaultVoiceFor("elevenlabs")).toBe("21m00Tcm4TlvDq8ikWAM");
    expect(defaultVoiceFor("deepgram")).toBe("");
  });
  it("providerSpeeds returns the speed set, [1] as fallback", () => {
    expect(providerSpeeds("openai")).toEqual([1, 1.25, 1.5, 2]);
    expect(providerSpeeds("elevenlabs")).toEqual([0.8, 0.9, 1, 1.1, 1.2]);
    expect(providerSpeeds("deepgram")).toEqual([1]);
    expect(providerSpeeds("bogus")).toEqual([1]);
  });
});
