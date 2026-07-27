import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSessionReportCard } from "./session-report.js";
import type { HandlerContext } from "./types.js";
import type { WsSessionReportCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const message = (over: Partial<WsSessionReportCard["card"]> = {}): WsSessionReportCard => ({
  type: "session_report_card",
  sessionId: "parent-1",
  card: {
    cardId: "session-report-1-0",
    fromSessionId: "child-1",
    fromTitle: "Elementalist catalog",
    fromBranch: "shipit/elem",
    relation: "child",
    severity: "blocker",
    subject: "regen wipes data/catalogs",
    body: "The shared regen command deletes every catalog.",
    createdAt: "2026-07-27T00:00:00.000Z",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleSessionReportCard (docs/233)", () => {
  it("appends a card-carrying message with the report payload", () => {
    handleSessionReportCard(ctx, message());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      sessionReport: {
        cardId: "session-report-1-0",
        fromSessionId: "child-1",
        relation: "child",
        severity: "blocker",
        body: "The shared regen command deletes every catalog.",
      },
    });
  });

  it("is idempotent by cardId — a reconnect replay against persisted history appends once", () => {
    handleSessionReportCard(ctx, message());
    handleSessionReportCard(ctx, message());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("omits absent optional fields rather than writing undefined", () => {
    handleSessionReportCard(ctx, message({ cardId: "c2", fromBranch: undefined, subject: undefined }));
    const report = useSessionStore.getState().messages[0].sessionReport!;
    expect("fromBranch" in report).toBe(false);
    expect("subject" in report).toBe(false);
  });
});
