import { describe, it, expect, beforeEach } from "vitest";
import { useIssueWriteStore } from "./issue-write-store.js";
import type { IssueWriteCard } from "../../server/shared/types.js";

function card(cardId: string, over: Partial<IssueWriteCard> = {}): IssueWriteCard {
  return {
    cardId,
    tracker: "github",
    issueId: "42",
    identifier: "octocat/hello#42",
    title: "Bug",
    url: "https://github.com/octocat/hello/issues/42",
    verb: "comment",
    summary: "commented on octocat/hello#42",
    attribution: "user",
    undo: { kind: "comment", commentId: "c-9" },
    undoState: "available",
    createdAt: "2026-06-05T00:00:00.000Z",
    ...over,
  };
}

describe("issue-write-store (docs/177 persistence)", () => {
  beforeEach(() => {
    useIssueWriteStore.getState().reset();
  });

  it("seeds an undone card from persisted history", () => {
    useIssueWriteStore.getState().seedCards([card("c1", { undoState: "undone" })]);
    expect(useIssueWriteStore.getState().cards.c1?.undoState).toBe("undone");
  });

  it("a re-delivered live card does not clobber an already-undone card (no-duplicate-on-replay)", () => {
    // History seed makes the card undone (authoritative).
    useIssueWriteStore.getState().seedCards([card("c1", { undoState: "undone" })]);
    // A turn-event-buffer replay re-delivers the original card on reconnect.
    useIssueWriteStore.getState().upsertCard(card("c1", { undoState: "available" }));
    // The undone state survives — upsert is non-clobbering.
    expect(useIssueWriteStore.getState().cards.c1?.undoState).toBe("undone");
  });

  it("upsert inserts a card only when absent", () => {
    useIssueWriteStore.getState().upsertCard(card("c1"));
    expect(useIssueWriteStore.getState().cards.c1?.undoState).toBe("available");
  });

  it("applies undo lifecycle transitions in place", () => {
    useIssueWriteStore.getState().upsertCard(card("c1"));
    useIssueWriteStore.getState().setUndoState("c1", "undoing");
    expect(useIssueWriteStore.getState().cards.c1?.undoState).toBe("undoing");
    useIssueWriteStore.getState().setUndoState("c1", "undone");
    expect(useIssueWriteStore.getState().cards.c1?.undoState).toBe("undone");
  });

  it("records an undo failure with its message", () => {
    useIssueWriteStore.getState().upsertCard(card("c1"));
    useIssueWriteStore.getState().setUndoState("c1", "failed", "not a collaborator");
    const c = useIssueWriteStore.getState().cards.c1;
    expect(c?.undoState).toBe("failed");
    expect(c?.errorMessage).toBe("not a collaborator");
  });
});
