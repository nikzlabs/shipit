import { describe, it, expect } from "vitest";
import { tailLines } from "./terminal-buffer.js";

describe("tailLines", () => {
  it("keeps the last lines and their terminating newline", () => {
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc\n");
  });

  it("counts an unterminated last line", () => {
    expect(tailLines("a\nb\nc", 2)).toBe("b\nc");
  });

  it("returns the whole text when it has no more lines than the limit", () => {
    expect(tailLines("a\nb\n", 2)).toBe("a\nb\n");
    expect(tailLines("a\nb\n", 10)).toBe("a\nb\n");
    expect(tailLines("", 3)).toBe("");
  });

  it("counts an empty line as a line", () => {
    expect(tailLines("\nb\n", 2)).toBe("\nb\n");
    expect(tailLines("a\n\nc\n", 2)).toBe("\nc\n");
  });
});
