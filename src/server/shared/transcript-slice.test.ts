import { describe, it, expect } from "vitest";
import { sliceBody, TRANSCRIPT_SLICE_LINES, TRANSCRIPT_SLICE_BYTES } from "./transcript-slice.js";

describe("sliceBody", () => {
  it("returns null for a body that already fits", () => {
    expect(sliceBody("one\ntwo\nthree")).toBeNull();
    expect(sliceBody("")).toBeNull();
  });

  it("returns null at exactly the line limit, and slices one line past it", () => {
    const atLimit = Array.from({ length: TRANSCRIPT_SLICE_LINES }, (_, i) => `line ${i}`).join("\n");
    expect(sliceBody(atLimit)).toBeNull();

    const overBy1 = `${atLimit}\nline extra`;
    const sliced = sliceBody(overBy1);
    expect(sliced).not.toBeNull();
    expect(sliced!.content.split("\n")).toHaveLength(TRANSCRIPT_SLICE_LINES);
    expect(sliced!.totalLines).toBe(TRANSCRIPT_SLICE_LINES + 1);
  });

  it("reports the TRUE line count, not the slice's — the 'Show all N lines' label depends on it", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const sliced = sliceBody(body)!;
    expect(sliced.totalLines).toBe(5000);
    expect(sliced.content.split("\n")).toHaveLength(TRANSCRIPT_SLICE_LINES);
    expect(sliced.totalBytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("the slice is always a genuine prefix of the original", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    expect(body.startsWith(sliceBody(body)!.content)).toBe(true);
  });

  it("applies the byte backstop to a single pathological line", () => {
    // One line, no newline to cut on — only the byte cap can bound this.
    const body = "x".repeat(TRANSCRIPT_SLICE_BYTES * 4);
    const sliced = sliceBody(body)!;
    expect(sliced.content.length).toBe(TRANSCRIPT_SLICE_BYTES);
    expect(sliced.totalLines).toBe(1);
    expect(sliced.totalBytes).toBe(TRANSCRIPT_SLICE_BYTES * 4);
  });

  it("never splits a UTF-8 codepoint at the byte boundary", () => {
    // Multi-byte characters straddling the cap: a naive byte slice would emit
    // U+FFFD, which would render as a mojibake tail in the preview.
    const body = "€".repeat(TRANSCRIPT_SLICE_BYTES);
    const sliced = sliceBody(body)!;
    expect(sliced.content).not.toContain("�");
    expect(Buffer.byteLength(sliced.content, "utf8")).toBeLessThanOrEqual(TRANSCRIPT_SLICE_BYTES);
    expect(body.startsWith(sliced.content)).toBe(true);
  });

  it("applies the byte backstop even when the line cap already cut", () => {
    // 50 lines, each far over the byte cap: the line cut leaves 40 lines, still
    // way too many bytes, so the backstop has to run on the result.
    const body = Array.from({ length: 50 }, () => "y".repeat(2000)).join("\n");
    const sliced = sliceBody(body)!;
    expect(Buffer.byteLength(sliced.content, "utf8")).toBeLessThanOrEqual(TRANSCRIPT_SLICE_BYTES);
  });

  it("bounds a 1 MB result to the slice budget", () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `output line number ${i}`).join("\n");
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(400_000);
    const sliced = sliceBody(body)!;
    expect(Buffer.byteLength(sliced.content, "utf8")).toBeLessThanOrEqual(TRANSCRIPT_SLICE_BYTES);
  });
});
