import { describe, it, expect } from "vitest";
import { buildReleaseConfirmMessage } from "./release-confirm-message.js";

/**
 * The confirm message must be mechanism-aware (docs/214). A `release-branch`
 * repo publishes by merging a version-bump PR — CI owns tagging — so the message
 * must NOT instruct the agent to create or push a tag. Every other mechanism
 * (tag-triggered default, brokered, unknown) keeps the tag-push wording.
 */
describe("buildReleaseConfirmMessage", () => {
  it("release-branch: opens/merges the bump PR and never mentions pushing a tag", () => {
    const text = buildReleaseConfirmMessage("0.3.0", "release-branch");
    expect(text).toContain("0.3.0");
    expect(text).toContain("version-bump PR");
    expect(text).toMatch(/release branch/i);
    // The whole point of the fix: no affirmative tag-push instruction for
    // release-branch (a prohibition like "Do NOT create or push a tag" is fine).
    expect(text).not.toMatch(/push the tag/i);
    expect(text).not.toMatch(/annotated tag/i);
  });

  it("tag-triggered: keeps the bump + annotated tag + push-the-tag wording", () => {
    const text = buildReleaseConfirmMessage("0.3.0", "tag-triggered");
    expect(text).toContain("0.3.0");
    expect(text).toContain("annotated tag");
    expect(text).toMatch(/push the tag/i);
  });

  it("brokered/unknown mechanisms fall back to the tag-triggered wording", () => {
    const text = buildReleaseConfirmMessage("1.0.0", "brokered");
    expect(text).toContain("annotated tag");
    expect(text).toMatch(/push the tag/i);
  });
});
