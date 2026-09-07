import { describe, it, expect } from "vitest";
import {
  LARGE_PASTE_THRESHOLD_CHARS,
  PASTED_TEXT_FILENAME,
  isLargePaste,
  buildPastedTextFile,
} from "./large-paste.js";

describe("large-paste", () => {
  it("uses the value the user approved", () => {
    // Every other case here is written against the constant, so it would stay
    // green if the threshold were changed. This is the one that pins 2,000.
    expect(LARGE_PASTE_THRESHOLD_CHARS).toBe(2000);
    expect(PASTED_TEXT_FILENAME).toBe("pasted-text.txt");
  });

  describe("isLargePaste", () => {
    it("is false one character below the threshold", () => {
      // docs/292 req 3 — a smaller paste still goes into the input as text.
      expect(isLargePaste("x".repeat(LARGE_PASTE_THRESHOLD_CHARS - 1))).toBe(false);
    });

    it("is true exactly at the threshold", () => {
      // docs/292 req 1 — "2,000 characters or more", so the boundary converts.
      expect(isLargePaste("x".repeat(LARGE_PASTE_THRESHOLD_CHARS))).toBe(true);
    });

    it("is false for an empty paste", () => {
      expect(isLargePaste("")).toBe(false);
    });

    it("counts newlines, so a tall narrow paste can cross the threshold", () => {
      expect(isLargePaste("a\n".repeat(LARGE_PASTE_THRESHOLD_CHARS / 2))).toBe(true);
    });

    it("counts an astral character once, not as its two code units", () => {
      // `"😀".length` is 2, so a naive length check converts this paste at half
      // the characters req 1 names.
      expect(isLargePaste("😀".repeat(LARGE_PASTE_THRESHOLD_CHARS - 1))).toBe(false);
      expect(isLargePaste("😀".repeat(LARGE_PASTE_THRESHOLD_CHARS))).toBe(true);
    });

    it("counts a mixed astral and ASCII paste by character", () => {
      const mixed = `${"😀".repeat(500)}${"x".repeat(1499)}`; // 1,999 characters, 2,499 code units
      expect(isLargePaste(mixed)).toBe(false);
      expect(isLargePaste(`${mixed}x`)).toBe(true);
    });

    it("stops counting at the threshold rather than walking the whole paste", () => {
      // A megabyte-sized paste must not cost a megabyte-sized scan.
      const huge = "x".repeat(5_000_000);
      const start = performance.now();
      expect(isLargePaste(huge)).toBe(true);
      expect(performance.now() - start).toBeLessThan(50);
    });
  });

  describe("buildPastedTextFile", () => {
    it("wraps the text verbatim as a text/plain file", async () => {
      const text = `line one\nline two\n${"x".repeat(3000)}`;
      const file = buildPastedTextFile(text);
      expect(file.name).toBe(PASTED_TEXT_FILENAME);
      expect(file.type).toBe("text/plain");
      expect(await file.text()).toBe(text);
    });

    it("sizes multi-byte text in bytes, not characters", () => {
      // The upload quota is byte-based; a character count would understate it.
      const file = buildPastedTextFile("é".repeat(10));
      expect(file.size).toBe(20);
    });
  });
});
