import { describe, it, expect } from "vitest";
import {
  LARGE_PASTE_THRESHOLD_CHARS,
  PASTED_TEXT_FILENAME,
  isLargePaste,
  buildPastedTextFile,
} from "./large-paste.js";

describe("large-paste", () => {
  it("uses the value the user approved", () => {

    expect(LARGE_PASTE_THRESHOLD_CHARS).toBe(2000);
    expect(PASTED_TEXT_FILENAME).toBe("pasted-text.txt");
  });

  describe("isLargePaste", () => {
    it("is false one character below the threshold", () => {

      expect(isLargePaste("x".repeat(LARGE_PASTE_THRESHOLD_CHARS - 1))).toBe(false);
    });

    it("is true exactly at the threshold", () => {

      expect(isLargePaste("x".repeat(LARGE_PASTE_THRESHOLD_CHARS))).toBe(true);
    });

    it("is false for an empty paste", () => {
      expect(isLargePaste("")).toBe(false);
    });

    it("counts newlines, so a tall narrow paste can cross the threshold", () => {
      expect(isLargePaste("a\n".repeat(LARGE_PASTE_THRESHOLD_CHARS / 2))).toBe(true);
    });

    it("counts an astral character once, not as its two code units", () => {

      expect(isLargePaste("😀".repeat(LARGE_PASTE_THRESHOLD_CHARS - 1))).toBe(false);
      expect(isLargePaste("😀".repeat(LARGE_PASTE_THRESHOLD_CHARS))).toBe(true);
    });

    it("counts a mixed astral and ASCII paste by character", () => {
      const mixed = `${"😀".repeat(500)}${"x".repeat(1499)}`;                                      
      expect(isLargePaste(mixed)).toBe(false);
      expect(isLargePaste(`${mixed}x`)).toBe(true);
    });

    it("stops counting at the threshold rather than walking the whole paste", () => {

      const original = String.prototype.charCodeAt;
      let reads = 0;
      // eslint-disable-next-line no-extend-native -- restored in the finally below
      String.prototype.charCodeAt = function (this: string, i: number) {
        reads++;
        return original.call(this, i);
      };
      try {
        expect(isLargePaste("x".repeat(5_000_000))).toBe(true);
      } finally {
        // eslint-disable-next-line no-extend-native -- restoring the original
        String.prototype.charCodeAt = original;
      }

      expect(reads).toBe(LARGE_PASTE_THRESHOLD_CHARS);
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

      const file = buildPastedTextFile("é".repeat(10));
      expect(file.size).toBe(20);
    });
  });
});
