import { describe, it, expect } from "vitest";
import { formatBlockquote } from "./format-blockquote.js";

describe("formatBlockquote", () => {
  it("prefixes a single line with '> '", () => {
    expect(formatBlockquote("Hello there")).toBe("> Hello there");
  });

  it("prefixes every line of a multi-line selection", () => {
    expect(formatBlockquote("line one\nline two")).toBe("> line one\n> line two");
  });

  it("keeps blank interior lines as a bare '>' so it stays one blockquote", () => {
    expect(formatBlockquote("a\n\nb")).toBe("> a\n>\n> b");
  });

  it("trims surrounding whitespace (e.g. a trailing newline from the selection)", () => {
    expect(formatBlockquote("\n  quoted  \n")).toBe("> quoted");
  });

  it("normalises CRLF line endings", () => {
    expect(formatBlockquote("a\r\nb")).toBe("> a\n> b");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(formatBlockquote("   \n  ")).toBe("");
  });
});
