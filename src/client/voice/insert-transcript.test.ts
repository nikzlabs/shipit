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

  it("starts a transcript that opens with a list on its own line", () => {
    const bullets = "- Fix the footer.\n- Rename the file.";
    expect(spliceTranscript({ value: "Two changes:", transcript: bullets }).value)
      .toBe(`Two changes:\n${bullets}`);
    const numbered = "1. Fix the footer.\n2. Rename the file.";
    expect(spliceTranscript({ value: "Two changes: ", transcript: numbered }).value)
      .toBe(`Two changes: \n${numbered}`);
    expect(spliceTranscript({ value: "Two changes:\n", transcript: bullets }).value)
      .toBe(`Two changes:\n${bullets}`);
    expect(spliceTranscript({ value: "", transcript: bullets }).value).toBe(bullets);
  });

  it("keeps a transcript that only starts like a list on the same line", () => {
    expect(spliceTranscript({ value: "bump to", transcript: "1.5 of the SDK" }).value)
      .toBe("bump to 1.5 of the SDK");
    expect(spliceTranscript({ value: "pass", transcript: "--force to the command" }).value)
      .toBe("pass --force to the command");
    expect(spliceTranscript({ value: "Use version ", transcript: "1. It has the fix." }).value)
      .toBe("Use version 1. It has the fix.");
  });

  it("keeps the text after the cursor off the last list item", () => {
    const bullets = "- Fix the footer.\n- Rename the file.";
    const r = spliceTranscript({
      value: "Changes:Afterwards, stop.",
      selectionStart: 8,
      selectionEnd: 8,
      transcript: bullets,
    });
    expect(r.value).toBe(`Changes:\n${bullets}\nAfterwards, stop.`);
    expect(r.value.slice(0, r.cursor)).toBe(`Changes:\n${bullets}`);

    expect(spliceTranscript({ value: "Changes:\nDone.", selectionStart: 8, selectionEnd: 8, transcript: bullets }).value)
      .toBe(`Changes:\n${bullets}\nDone.`);
  });

  it("does not add a leading space at the start of empty text", () => {
    const r = spliceTranscript({ value: "", transcript: "hi" });
    expect(r.value).toBe("hi");
    expect(r.cursor).toBe(2);
  });

  it("clamps out-of-range selection indices", () => {
    const r = spliceTranscript({ value: "abc", selectionStart: 99, selectionEnd: -5, transcript: "Z" });

    expect(r.value).toBe("abc Z");
  });
});
