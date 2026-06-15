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
    // obsolete-guard framing
    expect(msg).toMatch(/adapt or decline/i);
  });

  it("uses singular phrasing for one action", () => {
    const msg = formatProposalMessage(card, [card.actions[0]]);
    expect(msg).toContain("This action was proposed");
  });

  it("uses plural phrasing for several", () => {
    const msg = formatProposalMessage(card, card.actions);
    expect(msg).toContain("These 3 actions were proposed");
  });
});

describe("formatCommentSnapshot", () => {
  it("renders the WHOLE menu with [x]/[ ] payload lines and a Re: header", () => {
    const snapshot = formatCommentSnapshot(card, new Set(["a1", "a3"]));
    const lines = snapshot.split("\n");
    expect(lines[0]).toContain("Re: Optional follow-ups");
    expect(lines[0]).toContain("proposed 2026-06-15");
    expect(snapshot).toContain("[x] Open a PR for this change.");
    expect(snapshot).toContain("[ ] Update the API docs for the new route.");
    expect(snapshot).toContain("[x] File a follow-up issue for the rate-limit case.");
  });

  it("marks all unticked when the selection is empty", () => {
    const snapshot = formatCommentSnapshot(card, new Set());
    expect(snapshot).not.toContain("[x]");
    expect((snapshot.match(/\[ \]/g) ?? []).length).toBe(3);
  });

  it("ends with a trailing blank line so the user can append their own words", () => {
    expect(formatCommentSnapshot(card, new Set(["a1"]))).toMatch(/\n\n$/);
  });

  it("falls back to a generic heading when the card has no title", () => {
    const noTitle: ActionChecklistCard = { ...card, title: undefined };
    expect(formatCommentSnapshot(noTitle, new Set())).toContain("Re: proposed actions");
  });
});
