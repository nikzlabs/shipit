import { describe, it, expect } from "vitest";
import { pendingAnswerElementIndex } from "./pending-answer.js";
import { buildVisualElements } from "../visual-elements.js";
import type { ChatMessage } from "./types.js";

const ASK_INPUT = {
  questions: [
    {
      question: "Which cache?",
      header: "Cache",
      options: [{ label: "Redis", description: "External" }],
      multiSelect: false,
    },
  ],
};

function ask(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    role: "assistant",
    text: "",
    toolUse: [{ type: "tool_use", id: "ask-1", name: "AskUserQuestion", input: ASK_INPUT }],
    ...over,
  } as ChatMessage;
}

function voiceCard(): ChatMessage {
  return {
    role: "assistant",
    text: "",
    voiceNote: { id: "v1", headline: "Question on screen.", kind: "ask", createdAt: "t" },
  } as ChatMessage;
}

function find(messages: ChatMessage[]): number | null {
  return pendingAnswerElementIndex(buildVisualElements(messages), messages);
}

describe("pendingAnswerElementIndex", () => {
  it("finds the question card the conversation ends with", () => {
    const messages = [{ role: "user", text: "decide" } as ChatMessage, ask()];
    expect(find(messages)).toBe(1);
  });

  it("steps over a voice-note card emitted after the question", () => {
    const messages = [{ role: "user", text: "decide" } as ChatMessage, ask(), voiceCard()];
    // The question's element, not the card row that followed it.
    expect(find(messages)).toBe(1);
  });

  it("finds a question that shares its message with the agent's closing prose", () => {
    const messages = [
      { role: "user", text: "decide" } as ChatMessage,
      ask({ text: "Two options here." }),
      voiceCard(),
    ];
    expect(find(messages)).toBe(1);
  });

  it("finds a plan waiting for approval", () => {
    const messages = [
      { role: "user", text: "plan it" } as ChatMessage,
      {
        role: "assistant",
        text: "",
        toolUse: [{ type: "tool_use", id: "plan-1", name: "ExitPlanMode", input: { plan: "# Do it" } }],
      } as ChatMessage,
    ];
    expect(find(messages)).toBe(1);
  });

  it("leaves an answered question where it is", () => {
    const messages = [
      { role: "user", text: "decide" } as ChatMessage,
      ask({
        toolResults: [{ toolUseId: "ask-1", content: "Redis" }],
      }),
    ];
    expect(find(messages)).toBeNull();
  });

  it("leaves a question the user replied past rather than answered", () => {
    const messages = [
      { role: "user", text: "decide" } as ChatMessage,
      ask(),
      { role: "user", text: "never mind, do the other thing" } as ChatMessage,
    ];
    expect(find(messages)).toBeNull();
  });

  it("is null for an ordinary conversation, so nothing is lifted", () => {
    const messages = [
      { role: "user", text: "do it" } as ChatMessage,
      { role: "assistant", text: "done" } as ChatMessage,
    ];
    expect(find(messages)).toBeNull();
  });

  it("ignores a malformed question, which the CLI answers itself and never interrupts", () => {
    const messages = [
      { role: "user", text: "decide" } as ChatMessage,
      ask({ toolUse: [{ type: "tool_use", id: "ask-1", name: "AskUserQuestion", input: {} }] }),
    ];
    expect(find(messages)).toBeNull();
  });
});
