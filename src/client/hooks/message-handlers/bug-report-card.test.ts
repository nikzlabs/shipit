import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { useBugReportStore } from "../../stores/bug-report-store.js";
import { handleBugReportCard } from "./bug-report-card.js";
import type { HandlerContext } from "./types.js";
import type { WsBugReportCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const card = (over: Partial<WsBugReportCard> = {}): WsBugReportCard => ({
  type: "bug_report_card",
  sessionId: "s1",
  cardId: "bug-card-1",
  title: "Preview won't reload",
  body: "redacted body",
  stage2Ran: false,
  producer: "session",
  filedAs: "octocat",
  createdAt: "2026-06-03T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
  useBugReportStore.getState().reset();
});

describe("handleBugReportCard (docs/164)", () => {
  it("appends a marker message and seeds the store", () => {
    handleBugReportCard(ctx, card());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", text: "", bugReport: { cardId: "bug-card-1" } });
    expect(useBugReportStore.getState().cards["bug-card-1"]?.phase).toBe("draft");
  });

  it("(c) is idempotent by cardId — a duplicate delivery (reconnect replay) appends once", () => {
    handleBugReportCard(ctx, card());
    handleBugReportCard(ctx, card()); // same cardId, e.g. history load + buffer replay
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("(c) does not duplicate when the marker already came from persisted history", () => {
    // loadSessionHistory rehydrated a filed card marker into the message list.
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", bugReport: { cardId: "bug-card-1", phase: "filed" } }],
    });
    useBugReportStore.getState().seedCards([
      { ...card(), phase: "filed", issueNumber: 7, issueUrl: "https://github.com/nicolasalt/shipit/issues/7" },
    ]);

    // A buffer replay re-delivers the original draft.
    handleBugReportCard(ctx, card());

    expect(useSessionStore.getState().messages).toHaveLength(1);
    // The filed state survives the redundant draft delivery.
    expect(useBugReportStore.getState().cards["bug-card-1"]?.phase).toBe("filed");
  });
});
