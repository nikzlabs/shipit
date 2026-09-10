import { describe, it, expect } from "vitest";
import { getVoiceAdapters } from "./registry.js";

describe("getVoiceAdapters", () => {
  it("openai exposes both STT and TTS factories", () => {
    const a = getVoiceAdapters("openai");
    expect(typeof a?.createStt).toBe("function");
    expect(typeof a?.createTts).toBe("function");
    expect(a?.ttsContentType).toBe("audio/mpeg");
  });

  it("elevenlabs exposes TTS only", () => {
    const a = getVoiceAdapters("elevenlabs");
    expect(a?.createStt).toBeUndefined();
    expect(typeof a?.createTts).toBe("function");
    expect(a?.ttsContentType).toBe("audio/mpeg");
  });

  it("deepgram exposes STT only", () => {
    const a = getVoiceAdapters("deepgram");
    expect(typeof a?.createStt).toBe("function");
    expect(a?.createTts).toBeUndefined();
  });

  it("returns undefined for an unknown provider", () => {
    expect(getVoiceAdapters("bogus")).toBeUndefined();
  });
});
