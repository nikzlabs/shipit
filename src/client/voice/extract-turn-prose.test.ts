import { describe, it, expect } from "vitest";
import { extractTurnProse, hasSpeakableProse } from "./extract-turn-prose.js";
import type { ChatMessage } from "../components/MessageList.js";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { role: "assistant", text: "", ...partial } as ChatMessage;
}

describe("extractTurnProse", () => {
  it("joins assistant prose with blank-line separators", () => {
    const out = extractTurnProse([msg({ text: "First." }), msg({ text: "Second." })]);
    expect(out).toBe("First.\n\nSecond.");
  });

  it("ignores user messages", () => {
    const out = extractTurnProse([msg({ role: "user", text: "hi" }), msg({ text: "Reply." })]);
    expect(out).toBe("Reply.");
  });

  it("ignores error, notice, and rolled-back messages", () => {
    const out = extractTurnProse([
      msg({ text: "boom", isError: true }),
      msg({ text: "notice", notice: true } as Partial<ChatMessage>),
      msg({ text: "gone", rolledBack: true } as Partial<ChatMessage>),
      msg({ text: "Real." }),
    ]);
    expect(out).toBe("Real.");
  });

  it("skips empty/whitespace-only assistant text", () => {
    const out = extractTurnProse([msg({ text: "   " }), msg({ text: "Kept." })]);
    expect(out).toBe("Kept.");
  });

  it("returns empty string for an all-tool-call turn", () => {
    expect(extractTurnProse([msg({ text: "" }), msg({ text: "  " })])).toBe("");
  });
});

describe("hasSpeakableProse", () => {
  it("is true for ordinary prose", () => {
    expect(hasSpeakableProse("Hello there.")).toBe(true);
  });

  it("is false for empty input", () => {
    expect(hasSpeakableProse("")).toBe(false);
  });

  it("is false when only code blocks remain", () => {
    expect(hasSpeakableProse("```\nconst x = 1;\n```")).toBe(false);
  });

  it("is false for markdown punctuation only", () => {
    expect(hasSpeakableProse("--- ### ***")).toBe(false);
  });

  it("keeps link text as speakable", () => {
    expect(hasSpeakableProse("[the docs](http://x)")).toBe(true);
  });
});
