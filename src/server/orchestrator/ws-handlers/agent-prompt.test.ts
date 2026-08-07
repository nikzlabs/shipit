import { describe, it, expect } from "vitest";
import { assembleAgentPrompt } from "./agent-execution.js";
import { DICTATION_CONTEXT } from "../prompt-assembly.js";

const FILE_CTX = "<file_context>foo.ts</file_context>";
const IMAGE_CTX = "<attached_images>img</attached_images>";

describe("assembleAgentPrompt", () => {
  describe("non-slash messages (context prepended, legacy ordering)", () => {
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

  describe("slash invocations (context appended, slash kept at index 0)", () => {
    it("keeps a bare slash command at the start with no context", () => {
      expect(
        assembleAgentPrompt({ userText: "/my-skill", fileContext: "", imageContext: "" }),
      ).toBe("/my-skill");
    });

    it("appends file context AFTER the command so /skill stays at index 0", () => {
      const result = assembleAgentPrompt({
        userText: "/my-skill do it",
        fileContext: FILE_CTX,
        imageContext: "",
      });
      expect(result.startsWith("/my-skill do it")).toBe(true);
      expect(result).toBe(`/my-skill do it\n\n${FILE_CTX}`);
    });

    it("appends both file and image context after the command", () => {
      const result = assembleAgentPrompt({
        userText: "/my-skill",
        fileContext: FILE_CTX,
        imageContext: IMAGE_CTX,
      });
      expect(result.startsWith("/my-skill")).toBe(true);
      expect(result).toBe(`/my-skill\n\n${FILE_CTX}\n\n${IMAGE_CTX}`);
    });

    it("detects a slash command even with leading whitespace", () => {
      const result = assembleAgentPrompt({
        userText: "  /my-skill",
        fileContext: FILE_CTX,
        imageContext: "",
      });
      // Slash invocation ordering applies: user text first, then context.
      expect(result).toBe(`  /my-skill\n\n${FILE_CTX}`);
    });

    it("recognizes namespaced/dotted skill names", () => {
      const result = assembleAgentPrompt({
        userText: "/plugin:my.skill_name",
        fileContext: FILE_CTX,
        imageContext: "",
      });
      expect(result).toBe(`/plugin:my.skill_name\n\n${FILE_CTX}`);
    });

    it("does not treat a slash mid-message as an invocation", () => {
      const result = assembleAgentPrompt({
        userText: "what does a/b mean",
        fileContext: FILE_CTX,
        imageContext: "",
      });
      // Not a slash invocation → context prepended (legacy ordering).
      expect(result).toBe(`${FILE_CTX}\n\nwhat does a/b mean`);
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

    it("APPENDS the note for a dictated slash command, keeping /skill at index 0", () => {
      // A dictated `/review` must still resolve as a slash command — the CLI
      // only honors it at index 0, which is why the note moves to the back.
      const result = assembleAgentPrompt({
        userText: "/review the auth module",
        fileContext: FILE_CTX,
        imageContext: "",
        dictated: true,
      });
      expect(result.startsWith("/review the auth module")).toBe(true);
      expect(result).toBe(`/review the auth module\n\n${FILE_CTX}\n\n${DICTATION_CONTEXT}`);
    });

    it("names the artifacts the agent should expect, not just 'this was dictated'", () => {
      // Structural, not prose: the note is useless if it doesn't tell the agent
      // WHAT to be tolerant of, so assert the block wrapper and the two failure
      // modes it exists for rather than any particular sentence.
      expect(DICTATION_CONTEXT).toMatch(/^<dictated_input>/);
      expect(DICTATION_CONTEXT).toMatch(/<\/dictated_input>$/);
      expect(DICTATION_CONTEXT.toLowerCase()).toContain("transcri");
      expect(DICTATION_CONTEXT.toLowerCase()).toContain("punctuation");
    });
  });
});
