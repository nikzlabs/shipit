import { describe, it, expect } from "vitest";
import { spliceTranscript } from "./insert-transcript.js";

describe("spliceTranscript", () => {
  it("appends at end of text when no selection given", () => {
    const r = spliceTranscript({ value: "hello", transcript: "world" });
    expect(r.value).toBe("hello world");
    expect(r.cursor).toBe("hello world".length);
  });

  it("inserts at the cursor position", () => {
    const r = spliceTranscript({ value: "ab cd", selectionStart: 3, selectionEnd: 3, transcript: "XY" });
    // prev char is a space → no extra leading space
    expect(r.value).toBe("ab XYcd");
    expect(r.cursor).toBe(5);
  });

  it("replaces a selection", () => {
    const r = spliceTranscript({ value: "the quick fox", selectionStart: 4, selectionEnd: 9, transcript: "slow" });
    expect(r.value).toBe("the slow fox");
    expect(r.cursor).toBe("the slow".length);
  });

  it("adds a leading space when previous char is a word char", () => {
    const r = spliceTranscript({ value: "foo", selectionStart: 3, selectionEnd: 3, transcript: "bar" });
    expect(r.value).toBe("foo bar");
  });

  it("does not add a leading space after a newline or tab", () => {
    expect(spliceTranscript({ value: "foo\n", transcript: "bar" }).value).toBe("foo\nbar");
    expect(spliceTranscript({ value: "foo\t", transcript: "bar" }).value).toBe("foo\tbar");
  });

  it("does not add a leading space at the start of empty text", () => {
    const r = spliceTranscript({ value: "", transcript: "hi" });
    expect(r.value).toBe("hi");
    expect(r.cursor).toBe(2);
  });

  it("clamps out-of-range selection indices", () => {
    const r = spliceTranscript({ value: "abc", selectionStart: 99, selectionEnd: -5, transcript: "Z" });
    // start clamps to 3, end clamps to >= start
    expect(r.value).toBe("abc Z");
  });
});
