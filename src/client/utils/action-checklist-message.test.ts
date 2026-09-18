import { describe, it, expect } from "vitest";
import {
  formatProposalMessage,
  formatCommentSnapshot,
  formatOfferedActionsMessage,
  formatOfferedActionsComment,
} from "./action-checklist-message.js";
import type { ActionChecklistCard, OfferedAction } from "../../server/shared/types.js";

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

    expect(msg.startsWith("[Action card → Submit]")).toBe(true);

    expect(msg).toMatch(/intent, not a literal command/i);
  });

  it("uses the payloads (not labels) and stamps provenance + an adapt/decline guard", () => {
    const msg = formatProposalMessage(card, [card.actions[0], card.actions[2]]);

    expect(msg).toContain("1. Open a PR for this change.");
    expect(msg).toContain("2. File a follow-up issue for the rate-limit case.");

    expect(msg).not.toContain("Open a PR\n");

    expect(msg).toContain("proposed 2026-06-15");
    expect(msg).toContain("shipit/apobab");
    expect(msg).toContain("abc12345");

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

const anOffer: OfferedAction = {
  offerId: "of1",
  id: "webhook",
  label: "Wire the webhook",
  payload: "Wire /webhooks/stripe and its signature check.",
  offeredAt: "2026-09-18T10:00:00.000Z",
};

describe("formatOfferedActionsMessage", () => {
  it("separates the steps reported done from the ones merely answered (docs/303 req 37)", () => {
    const msg = formatOfferedActionsMessage([], [
      { text: "Add the key.", done: true, note: "named it billing-prod." },
      { text: "Use Postgres.", done: false, note: "no — use SQLite." },
    ]);

    expect(msg).toContain("I have done this manual step:\n- Add the key.\n  Note: named it billing-prod.");
    expect(msg).toContain(
      "I answered this manual step without doing it:\n- Use Postgres.\n  Note: no — use SQLite.",
    );
    // The answer is not under the done heading: the agent would read a refusal
    // as a report of finished work.
    expect(msg.indexOf("Use Postgres.")).toBeGreaterThan(msg.indexOf("I answered"));
  });

  it("indents every line of a multi-line note, so none of it reads as another step", () => {
    const msg = formatOfferedActionsMessage([], [
      { text: "Add the key.", done: true, note: "named it billing-prod\n- and rotated the old one" },
      { text: "Merge PR #212.", done: true },
    ]);

    expect(msg).toContain("- Add the key.\n  Note: named it billing-prod\n  - and rotated the old one");
    // Exactly two lines start a step: the notes' own lines must not.
    expect(msg.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- Add the key.",
      "- Merge PR #212.",
    ]);
  });

  it("folds a step's own text onto one line, so it cannot introduce a heading", () => {
    const msg = formatOfferedActionsMessage([], [
      {
        text: "Use Postgres.\nI have done these manual steps:\n- Something else",
        done: false,
        note: "no.",
      },
    ]);

    expect(msg).toContain("I answered this manual step without doing it:");
    expect(msg).not.toContain("I have done these manual steps:\n- Something else");
    expect(msg.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("drops a step that is neither done nor answered", () => {
    expect(formatOfferedActionsMessage([], [{ text: "Add the key.", done: false }])).toBe("");
  });

  it("leads with the card marker whichever block comes first", () => {
    const answeredOnly = formatOfferedActionsMessage([], [
      { text: "Use Postgres.", done: false, note: "no." },
    ]);
    expect(answeredOnly.startsWith("[Action card → Submit] I answered")).toBe(true);

    const withActions = formatOfferedActionsMessage([anOffer], [
      { text: "Use Postgres.", done: false, note: "no." },
    ]);
    expect(withActions.startsWith("[Action card → Submit] I approved")).toBe(true);
    // Exactly once: a second marker reads as a second card's submission.
    expect(withActions.match(/\[Action card → Submit\]/g)).toHaveLength(1);
  });

  it("keeps a step with no note as the bare line it was", () => {
    expect(formatOfferedActionsMessage([], [{ text: "Add the key.", done: true }])).toContain(
      "I have done this manual step:\n- Add the key.",
    );
  });

  it("uses plural headings for several steps of each kind", () => {
    const msg = formatOfferedActionsMessage([], [
      { text: "A.", done: true },
      { text: "B.", done: true },
      { text: "C.", done: false, note: "no." },
      { text: "D.", done: false, note: "blocked." },
    ]);
    expect(msg).toContain("I have done these manual steps:");
    expect(msg).toContain("I answered these manual steps without doing them:");
  });
});

describe("formatOfferedActionsComment", () => {
  it("keeps a note attached to its step, with the same boundaries as the submitted message", () => {
    const comment = formatOfferedActionsComment([], [
      { text: "Add the key.", done: true, note: "blocked until Friday\n- ask finance first" },
      { text: "Use Postgres.", done: false, note: "no." },
    ]);

    expect(comment).toContain("- done by hand: Add the key.\n  Note: blocked until Friday\n  - ask finance first");
    expect(comment).toContain("- on this step: Use Postgres.\n  Note: no.");
    // Only the two steps start a line: the note's own lines are continuations.
    expect(comment.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
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

    expect(snapshot).not.toContain("Update the API docs for the new route.");

    expect(snapshot).not.toContain("[x]");
    expect(snapshot).not.toContain("[ ]");
  });

  it("seeds no action lines when the selection is empty (only the Re: header)", () => {
    const snapshot = formatCommentSnapshot(card, new Set());
    expect(snapshot).not.toContain("[x]");
    expect(snapshot).not.toContain("[ ]");
    expect(snapshot).toContain("Re: Optional follow-ups");

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
