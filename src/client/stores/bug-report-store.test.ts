import { describe, it, expect, beforeEach } from "vitest";
import { useBugReportStore, type BugReportCardState } from "./bug-report-store.js";

function draft(cardId: string): Omit<BugReportCardState, "phase"> {
  return {
    cardId,
    title: "Preview won't reload",
    body: "redacted body",
    stage2Ran: false,
    producer: "session",
    filedAs: "octocat",
  };
}

describe("bug-report-store (docs/164 persistence)", () => {
  beforeEach(() => {
    useBugReportStore.getState().reset();
  });

  it("seeds a filed card from persisted history", () => {
    useBugReportStore.getState().seedCards([
      {
        ...draft("c1"),
        phase: "filed",
        issueNumber: 1234,
        issueUrl: "https://github.com/nicolasalt/shipit/issues/1234",
      },
    ]);
    const card = useBugReportStore.getState().cards.c1;
    expect(card?.phase).toBe("filed");
    expect(card?.issueNumber).toBe(1234);
  });

  it("(c) a re-delivered draft does not clobber an already-filed card", () => {
    // History seed makes the card filed (authoritative).
    useBugReportStore.getState().seedCards([
      {
        ...draft("c1"),
        phase: "filed",
        issueNumber: 1234,
        issueUrl: "https://github.com/nicolasalt/shipit/issues/1234",
      },
    ]);
    // A turn-event-buffer replay re-delivers the original draft on reconnect.
    useBugReportStore.getState().upsertCard(draft("c1"));
    // The filed state survives — upsert is non-clobbering.
    expect(useBugReportStore.getState().cards.c1?.phase).toBe("filed");
  });

  it("upsert creates a draft only when the card is absent", () => {
    useBugReportStore.getState().upsertCard(draft("c1"));
    expect(useBugReportStore.getState().cards.c1?.phase).toBe("draft");
  });

  it("(d) a failed submission drops the card back to an editable draft", () => {
    useBugReportStore.getState().upsertCard(draft("c1"));
    useBugReportStore.getState().setFailed("c1", "Reconnect GitHub.", true);
    const card = useBugReportStore.getState().cards.c1;
    expect(card?.phase).toBe("draft");
    expect(card?.errorMessage).toContain("Reconnect GitHub");
    expect(card?.scopeError).toBe(true);
  });
});
