import { describe, expect, it, vi } from "vitest";
import { SessionRunner } from "../session-runner.js";
import { deriveAskHeadline, derivePlanHeadline, observeVoiceNotes } from "./agent-voice-handler.js";
import type { ClaudeContentBlockToolUse } from "../../shared/types.js";

const tool = (name: string, input: unknown): ClaudeContentBlockToolUse =>
  ({ type: "tool_use", id: "t", name, input }) as ClaudeContentBlockToolUse;

function runner() {
  return new SessionRunner({ sessionId: "session-1", sessionDir: "/tmp/session-1", defaultAgentId: "codex" });
}

describe("deriveAskHeadline", () => {
  it("voices the first question's header but never the options", () => {
    expect(deriveAskHeadline({ questions: [{ header: "delivery", question: "How?" }] }))
      .toBe("I've got a question about delivery — options are on screen.");
  });

  it("falls back to the question text, then a generic line", () => {
    expect(deriveAskHeadline({ questions: [{ question: "Which database?" }] }))
      .toContain("Which database?");
    expect(deriveAskHeadline({})).toBe("I've got a question for you — options are on screen.");
  });
});

describe("derivePlanHeadline", () => {
  it("voices the plan's title line with heading markers stripped", () => {
    expect(derivePlanHeadline({ plan: "# Add voice notes\nStep one" }))
      .toBe("I've drafted a plan — Add voice notes. Want to review it?");
  });

  it("falls back to a generic line for an empty plan", () => {
    expect(derivePlanHeadline({ plan: "" })).toBe("I've drafted a plan — want to review it?");
  });
});

describe("observeVoiceNotes", () => {
  it("delivers an authored card from the voice_note tool input", () => {
    const r = runner();
    const deliver = vi.fn();
    observeVoiceNotes(r, [
      tool("mcp__shipit__voice_note", { summary: "Your call.", needsAttention: true, context: { repo: "a/b" } }),
    ], deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [payload, , source] = deliver.mock.calls[0];
    expect(source).toBe("authored");
    expect(payload).toMatchObject({ summary: "Your call.", needsAttention: true, context: { repo: "a/b" } });
    r.dispose({ force: true });
  });

  it("derives an ask headline as the fallback floor when nothing was authored", () => {
    const r = runner();
    const deliver = vi.fn();
    observeVoiceNotes(r, [tool("AskUserQuestion", { questions: [{ header: "direction" }] })], deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][2]).toBe("ask");
    r.dispose({ force: true });
  });

  it("is a no-op when no deliver callback is wired", () => {
    const r = runner();
    expect(() => observeVoiceNotes(r, [tool("AskUserQuestion", { questions: [{ header: "x" }] })], undefined)).not.toThrow();
    r.dispose({ force: true });
  });
});
