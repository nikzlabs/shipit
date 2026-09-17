import { describe, it, expect } from "vitest";
import { assembleAgentPrompt } from "./agent-execution.js";
import { DICTATION_CONTEXT } from "../prompt-assembly.js";

const FILE_CTX = "<file_context>foo.ts</file_context>";
const IMAGE_CTX = "<attached_images>img</attached_images>";

describe("assembleAgentPrompt", () => {
  describe("context ordering", () => {
    it("returns user text unchanged when no context", () => {
      expect(
        assembleAgentPrompt({ userText: "fix the bug", fileContext: "", imageContext: "" }),
      ).toBe("fix the bug");
    });

    it("prepends file context before the user text", () => {
      expect(
        assembleAgentPrompt({ userText: "fix the bug", fileContext: FILE_CTX, imageContext: "" }),
      ).toBe(`${FILE_CTX}\n\nfix the bug`);
    });

    it("orders image, then file, then user text", () => {
      expect(
        assembleAgentPrompt({
          userText: "fix the bug",
          fileContext: FILE_CTX,
          imageContext: IMAGE_CTX,
        }),
      ).toBe(`${IMAGE_CTX}\n\n${FILE_CTX}\n\nfix the bug`);
    });
  });

  describe("dictated messages (docs/144)", () => {
    it("adds nothing when the message was typed", () => {
      expect(
        assembleAgentPrompt({ userText: "fix the bug", fileContext: "", imageContext: "" }),
      ).toBe("fix the bug");
      expect(
        assembleAgentPrompt({
          userText: "fix the bug",
          fileContext: "",
          imageContext: "",
          dictated: false,
        }),
      ).toBe("fix the bug");
    });

    it("prepends the dictation note ahead of every other context block", () => {
      expect(
        assembleAgentPrompt({
          userText: "fix the bug",
          fileContext: FILE_CTX,
          imageContext: IMAGE_CTX,
          dictated: true,
        }),
      ).toBe(`${DICTATION_CONTEXT}\n\n${IMAGE_CTX}\n\n${FILE_CTX}\n\nfix the bug`);
    });

    it("carries the note with no other context", () => {
      expect(
        assembleAgentPrompt({
          userText: "fix the bug",
          fileContext: "",
          imageContext: "",
          dictated: true,
        }),
      ).toBe(`${DICTATION_CONTEXT}\n\nfix the bug`);
    });

    it("names the artifacts the agent should expect, not just 'this was dictated'", () => {
      expect(DICTATION_CONTEXT).toMatch(/^<dictated_input>/);
      expect(DICTATION_CONTEXT).toMatch(/<\/dictated_input>$/);
      expect(DICTATION_CONTEXT.toLowerCase()).toContain("transcri");
      expect(DICTATION_CONTEXT.toLowerCase()).toContain("punctuation");
    });
  });

  describe("docs/272-user-selectable-roles req 2 — a role's standing instructions", () => {
    const ROLE_CTX = '<role_instructions role="deep dive">\nRead everything first.\n</role_instructions>';

    it("goes FIRST, so it frames the attachments and the task", () => {
      expect(
        assembleAgentPrompt({
          userText: "fix the bug",
          fileContext: FILE_CTX,
          imageContext: IMAGE_CTX,
          roleContext: ROLE_CTX,
        }),
      ).toBe(`${ROLE_CTX}\n\n${IMAGE_CTX}\n\n${FILE_CTX}\n\nfix the bug`);
    });

    it("changes nothing when the session is not on a role", () => {
      expect(
        assembleAgentPrompt({ userText: "fix the bug", fileContext: "", imageContext: "" }),
      ).toBe("fix the bug");
    });
  });
});
