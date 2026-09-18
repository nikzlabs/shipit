import { describe, expect, it } from "vitest";
import {
  buildTextChange,
  summarizeText,
  unshowableCharacter,
} from "./settings-text-change.js";

/**
 * The card's account of a prose change (docs/299-agent-settings-access req 9).
 *
 * What is being pinned is that it is a FULL-CONTEXT diff: the whole before and
 * the whole after are in it. A hunk view would be a summary of what Apply
 * writes, and a card the user cannot check in full is the thing the refusal
 * underneath this feature exists to prevent.
 */

function reconstruct(lines: { kind: string; text: string }[], side: "before" | "after"): string {
  const keep = side === "before" ? "removed" : "added";
  return lines.filter((line) => line.kind === "context" || line.kind === keep)
    .map((line) => line.text)
    .join("\n");
}

describe("buildTextChange", () => {
  it("carries the whole before and the whole after, not a sample of them", () => {
    const before = "Always run the tests.\nUse tabs.\nAsk before deleting.";
    const after = "Always run the tests.\nUse spaces.\nAsk before deleting.\nPrefer small PRs.";

    const change = buildTextChange(before, after);

    expect(reconstruct(change.lines, "before")).toBe(before);
    expect(reconstruct(change.lines, "after")).toBe(after);
  });

  it("marks only the lines that moved, so a one-line edit reads as one line", () => {
    const before = ["a", "b", "c", "d", "e"].join("\n");
    const after = ["a", "b", "CHANGED", "d", "e"].join("\n");

    const change = buildTextChange(before, after);

    expect(change.added).toBe(1);
    expect(change.removed).toBe(1);
    expect(change.lines.filter((line) => line.kind === "context")).toHaveLength(4);
  });

  it("keeps an unchanged line BETWEEN two changes as context", () => {
    // Prefix and suffix trimming cannot supply this one, so it is what the LCS
    // itself has to find: replacing `diffMiddle` with `wholeMiddle` turns the
    // middle line into a removal and an addition.
    const before = ["a", "OLD ONE", "shared middle", "OLD TWO", "z"].join("\n");
    const after = ["a", "NEW ONE", "shared middle", "NEW TWO", "z"].join("\n");

    const change = buildTextChange(before, after);

    expect(change.lines.filter((line) => line.kind === "context").map((line) => line.text))
      .toEqual(["a", "shared middle", "z"]);
    expect(change.added).toBe(2);
    expect(change.removed).toBe(2);
  });

  it("counts the whole value, so padding cannot hide its own bulk", () => {
    const after = `real content${"\n".repeat(400)}`;

    const change = buildTextChange("", after);

    expect(change.after.lines).toBe(401);
    expect(change.after.chars).toBe(after.length);
    expect(change.before).toEqual({ chars: 0, lines: 0 });
  });

  it("still shows both versions whole when the change is too large to align", () => {
    // Single-character lines are the shape that blows past MAX_DIFF_CELLS. The
    // fallback says less about which lines survived and still displays
    // everything the button would write.
    const before = Array.from({ length: 1200 }, (_, i) => String(i % 7)).join("\n");
    const after = Array.from({ length: 1200 }, (_, i) => String((i + 3) % 7)).join("\n");

    const change = buildTextChange(before, after);

    expect(reconstruct(change.lines, "before")).toBe(before);
    expect(reconstruct(change.lines, "after")).toBe(after);
  });
});

describe("unshowableCharacter", () => {
  it("names a bidirectional override, which makes the card show what Apply will not write", () => {
    expect(unshowableCharacter("run the tests\u202Eyllufwal")).toContain("bidirectional override");
    expect(unshowableCharacter("run the\u2066 tests")).toContain("bidirectional override");
  });

  it("names invisible formatting and control characters", () => {
    expect(unshowableCharacter("run\u200Bthe tests")).toContain("invisible");
    expect(unshowableCharacter("run the\u0007tests")).toContain("control character");
  });

  /**
   * A hand-listed range missed every one of these, which is why the check is
   * the Unicode property instead.
   */
  it("names the invisible characters a hand-written range leaves out", () => {
    for (const invisible of ["\u00AD", "\u034F", "\u061C", "\u{E0061}", "\u3164"]) {
      expect(unshowableCharacter(`run the tests${invisible} now`)).toContain("invisible");
    }
  });

  it("passes the three that are genuinely part of prose", () => {
    expect(unshowableCharacter("line one\nline\ttwo\r\nline three")).toBeNull();
    expect(unshowableCharacter("héllo — “quoted”, 日本語")).toBeNull();
  });

  it("passes an emoji written with a variation selector", () => {
    // Ignorable by the same property, and how "❤️" is spelled. Refusing it would
    // make the check a nuisance rather than a display-integrity guarantee.
    expect(unshowableCharacter("Ship it ❤️")).toBeNull();
  });
});

describe("summarizeText", () => {
  it("stands in for prose the card carries in its diff instead", () => {
    expect(summarizeText("")).toBe("empty");
    expect(summarizeText("x".repeat(1234))).toBe("1,234 characters");
  });
});
