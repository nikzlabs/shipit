import { describe, expect, it } from "vitest";
import { stripAnsi } from "./strip-ansi.js";

describe("stripAnsi", () => {
  it("removes colour and cursor sequences", () => {
    expect(stripAnsi("\x1b[90mgrey\x1b[0m\x1b[2Ktail")).toBe("greytail");
  });

  /**
   * An OSC ends at BEL or at the string terminator `ESC \`. Matching only BEL
   * swallowed the terminator and everything after it, up to the next BEL —
   * which on a terminal that uses ST is arbitrary output, not an escape.
   */
  it("ends an OSC at either terminator", () => {
    expect(stripAnsi("\x1b]0;title\x07rest")).toBe("rest");
    expect(stripAnsi("\x1b]0;title\x1b\\rest")).toBe("rest");
  });

  /**
   * The body excludes ESC, and that is what keeps this linear: a body that may
   * contain ESC rescans to the end of the text from every `\x1b]` in it. 32 KiB
   * of them took 425 ms, and the sign-in panel hands this whole CLI lines.
   */
  it("does not rescan from every escape in a run of unterminated ones", () => {
    const started = Date.now();
    stripAnsi("\x1b]".repeat(16 * 1024));

    expect(Date.now() - started).toBeLessThan(250);
  });
});
