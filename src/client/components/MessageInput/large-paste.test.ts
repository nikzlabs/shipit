import { describe, it, expect } from "vitest";
import {
  LARGE_PASTE_THRESHOLD_CHARS,
  PASTED_TEXT_FILENAME,
  isLargePaste,
  buildPastedTextFile,
} from "./large-paste.js";

describe("large-paste", () => {
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
