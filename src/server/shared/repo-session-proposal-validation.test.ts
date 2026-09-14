import { describe, it, expect } from "vitest";
import {
  validateRepoSessionProposal,
  MAX_PROMPT_LEN,
  MAX_SESSION_TITLE_LEN,
} from "./repo-session-proposal-validation.js";

const valid = {
  repo: "acme/api",
  title: "Add cursor pagination to /events",
  prompt: "Add cursor pagination to GET /events, matching the contract in acme/web.",
};

describe("validateRepoSessionProposal", () => {
  it("accepts and trims a complete proposal", () => {
    const result = validateRepoSessionProposal({
      repo: "  acme/api  ",
      title: "  Pagination  ",
      prompt: "  Do the thing.  ",
    });
    expect(result).toEqual({ repo: "acme/api", title: "Pagination", prompt: "Do the thing." });
  });

  for (const field of ["repo", "title", "prompt"] as const) {
    it(`rejects a missing ${field}`, () => {
      const result = validateRepoSessionProposal({ ...valid, [field]: "   " });
      expect(result).toMatchObject({ error: expect.stringContaining(`\`${field}\``) });
    });

    it(`rejects a non-string ${field}`, () => {
      const result = validateRepoSessionProposal({ ...valid, [field]: 42 });
      expect(result).toMatchObject({ error: expect.stringContaining(`\`${field}\``) });
    });
  }

  it("rejects a title longer than the sidebar cap", () => {
    const result = validateRepoSessionProposal({ ...valid, title: "x".repeat(MAX_SESSION_TITLE_LEN + 1) });
    expect(result).toMatchObject({ error: expect.stringContaining(String(MAX_SESSION_TITLE_LEN)) });
  });

  it("accepts a title exactly at the cap", () => {
    const title = "x".repeat(MAX_SESSION_TITLE_LEN);
    expect(validateRepoSessionProposal({ ...valid, title })).toMatchObject({ title });
  });

  it("rejects a prompt longer than the cap", () => {
    const result = validateRepoSessionProposal({ ...valid, prompt: "x".repeat(MAX_PROMPT_LEN + 1) });
    expect(result).toMatchObject({ error: expect.stringContaining(String(MAX_PROMPT_LEN)) });
  });

  it("counts code points, not UTF-16 units, so emoji do not inflate the length", () => {
    const prompt = "😀".repeat(MAX_PROMPT_LEN);
    expect(validateRepoSessionProposal({ ...valid, prompt })).toMatchObject({ prompt });
  });
});
