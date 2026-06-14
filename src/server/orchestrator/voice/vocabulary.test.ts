import { describe, it, expect } from "vitest";
import { CODING_VOCABULARY, WHISPER_BIAS_PROMPT, DEEPGRAM_KEYWORDS } from "./vocabulary.js";

describe("coding vocabulary", () => {
  it("joins the term list into the Whisper bias prompt", () => {
    expect(WHISPER_BIAS_PROMPT).toBe(CODING_VOCABULARY.join(", "));
    expect(WHISPER_BIAS_PROMPT).toContain("pull request");
  });

  it("splits multi-word terms into single tokens for Deepgram keywords", () => {
    // "pull request" → "pull", "request"; "Claude Code" → "Claude", "Code".
    expect(DEEPGRAM_KEYWORDS).toContain("pull");
    expect(DEEPGRAM_KEYWORDS).toContain("request");
    expect(DEEPGRAM_KEYWORDS).toContain("Code");
    expect(DEEPGRAM_KEYWORDS.some((k) => k.includes(" "))).toBe(false);
  });

  it("de-duplicates tokens that appear in more than one term", () => {
    // "Claude" appears standalone and in "Claude Code".
    const claudeCount = DEEPGRAM_KEYWORDS.filter((k) => k === "Claude").length;
    expect(claudeCount).toBe(1);
  });
});
