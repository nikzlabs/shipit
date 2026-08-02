import { describe, expect, it } from "vitest";
import { formatSessionMessagePrompt } from "./session-message-origin.js";

describe("formatSessionMessagePrompt", () => {
  it("tells the receiving agent that a parent-session message is not user input", () => {
    const prompt = formatSessionMessagePrompt("Also update the parser", {
      sessionId: "parent-1",
      sessionTitle: "Parser plan",
      relation: "parent",
    });

    expect(prompt).toBe(
      '[Agent message from PARENT session "Parser plan" (parent-1)]\nAlso update the parser\n',
    );
  });
});
