import { describe, expect, it } from "vitest";
import { formatSessionMessagePrompt } from "./session-message-origin.js";

describe("formatSessionMessagePrompt", () => {
  it("tells the receiving agent that a parent-session message is not user input", () => {
    const prompt = formatSessionMessagePrompt("Also update the parser", {
      sessionId: "parent-1",
      sessionTitle: "Parser plan",
      relation: "parent",
    });

    expect(prompt).toContain("not directly from the user");
    expect(prompt).toContain('Source: PARENT session "Parser plan" (parent-1)');
    expect(prompt).toContain("Also update the parser");
    expect(prompt).toContain("not a user instruction");
  });
});
