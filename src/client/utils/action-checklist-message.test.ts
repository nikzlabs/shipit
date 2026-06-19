import { describe, it, expect } from "vitest";
import { formatProposalMessage, formatCommentSnapshot } from "./action-checklist-message.js";
import type { ActionChecklistCard } from "../../server/shared/types.js";

const card: ActionChecklistCard = {
  cardId: "ac1",
  title: "Optional follow-ups",
  actions: [
    { id: "a1", label: "Open a PR", payload: "Open a PR for this change." },
    { id: "a2", label: "Update docs", payload: "Update the API docs for the new route." },
    { id: "a3", label: "File issue", payload: "File a follow-up issue for the rate-limit case." },
  ],
  branch: "shipit/apobab",
  headSha: "abc12345",
  createdAt: "2026-06-15T11:34:00.000Z",
};

describe("formatProposalMessage", () => {
  it("leads with the card-injected marker + intent framing", () => {
    const msg = formatProposalMessage(card, [card.actions[0]]);
    // explicit card-injected provenance marker, at the very start
    expect(msg.startsWith("[Action card → Submit]")).toBe(true);
    // framed as intent, not a literal command
    expect(msg).toMatch(/intent, not a literal command/i);
  });

  it("uses the payloads (not labels) and stamps provenance + an adapt/decline guard", () => {
    const msg = formatProposalMessage(card, [card.actions[0], card.actions[2]]);
    // payloads, numbered, in order
    expect(msg).toContain("1. Open a PR for this change.");
    expect(msg).toContain("2. File a follow-up issue for the rate-limit case.");
    // NOT the short labels
    expect(msg).not.toContain("Open a PR\n");
    // provenance
    expect(msg).toContain("proposed 2026-06-15");
    expect(msg).toContain("shipit/apobab");
    expect(msg).toContain("abc12345");
    // re-check-state / obsolete-guard framing
    expect(msg).toMatch(/adapt or decline/i);
  });

  it("uses singular phrasing for one action", () => {
    const msg = formatProposalMessage(card, [card.actions[0]]);
    expect(msg).toMatch(/approved this action/i);
  });

  it("uses plural phrasing for several", () => {
    const msg = formatProposalMessage(card, card.actions);
    expect(msg).toMatch(/approved these 3 actions/i);
  });
});

describe("formatCommentSnapshot", () => {
  it("renders ONLY the selected actions as `- ` bullet lines with a Re: header", () => {
    const snapshot = formatCommentSnapshot(card, new Set(["a1", "a3"]));
    const lines = snapshot.split("\n");
    expect(lines[0]).toContain("Re: Optional follow-ups");
    expect(lines[0]).toContain("proposed 2026-06-15");
    expect(snapshot).toContain("- Open a PR for this change.");
    expect(snapshot).toContain("- File a follow-up issue for the rate-limit case.");
    // unselected actions are NOT filled into the composer at all
    expect(snapshot).not.toContain("Update the API docs for the new route.");
    // no checkbox markers — every seeded line is selected by definition
    expect(snapshot).not.toContain("[x]");
    expect(snapshot).not.toContain("[ ]");
  });

  it("seeds no action lines when the selection is empty (only the Re: header)", () => {
    const snapshot = formatCommentSnapshot(card, new Set());
    expect(snapshot).not.toContain("[x]");
    expect(snapshot).not.toContain("[ ]");
    expect(snapshot).toContain("Re: Optional follow-ups");
    // header line, then the trailing blank lines — no action payloads
    expect(snapshot).not.toContain("Open a PR for this change.");
  });

  it("ends with a trailing blank line so the user can append their own words", () => {
    expect(formatCommentSnapshot(card, new Set(["a1"]))).toMatch(/\n\n$/);
  });

  it("falls back to a generic heading when the card has no title", () => {
    const noTitle: ActionChecklistCard = { ...card, title: undefined };
    expect(formatCommentSnapshot(noTitle, new Set())).toContain("Re: proposed actions");
  });
});
