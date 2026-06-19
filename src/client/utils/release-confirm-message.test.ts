import { describe, it, expect } from "vitest";
import { buildReleaseConfirmMessage } from "./release-confirm-message.js";

/**
 * The confirm message is card-injected (not hand-typed), so every variant carries
 * a provenance marker and frames the body as intent + "re-check state" — mirroring
 * action-checklist-message.ts (docs/214). A `release-branch` repo publishes by
 * merging a version-bump PR (CI owns tagging), so the message must NOT give an
 * affirmative tag-push instruction — but it must NOT phrase that as an absolute
 * prohibition either, because the documented cold-start remedy is a one-time
 * tag-path bootstrap. Every other mechanism (tag-triggered default, brokered,
 * unknown) keeps the tag-push wording.
 */
describe("buildReleaseConfirmMessage", () => {
  it("release-branch: provenance marker, bump PR + CI-tags-on-merge intent, signals re-check state", () => {
    const text = buildReleaseConfirmMessage("0.3.0", "release-branch");
    expect(text).toContain("0.3.0");
    // Card-injected provenance marker so the agent treats it as intent, not a
    // verbatim instruction.
    expect(text).toContain("Release card");
    expect(text).toContain("version-bump PR");
    expect(text).toMatch(/release branch/i);
    // CI tags on merge — intent preserved.
    expect(text).toMatch(/CI/);
    // Judgment framing: re-check current state / the cold-start warning rather
    // than obeying the literal string.
    expect(text).toMatch(/warning/i);
    expect(text).toMatch(/re-check|current state/i);
    // The spirit of the fix: no affirmative "go push a tag" instruction for the
    // steady-state release-branch flow (but no absolute prohibition either).
    expect(text).not.toMatch(/push the tag/i);
    expect(text).not.toMatch(/annotated tag/i);
  });

  it("tag-triggered: provenance marker + bump + annotated tag + push-the-tag wording", () => {
    const text = buildReleaseConfirmMessage("0.3.0", "tag-triggered");
    expect(text).toContain("0.3.0");
    expect(text).toContain("Release card");
    expect(text).toContain("annotated tag");
    expect(text).toMatch(/push the tag/i);
  });

  it("brokered/unknown mechanisms fall back to the tag-triggered wording (with marker)", () => {
    const text = buildReleaseConfirmMessage("1.0.0", "brokered");
    expect(text).toContain("Release card");
    expect(text).toContain("annotated tag");
    expect(text).toMatch(/push the tag/i);
  });
});
