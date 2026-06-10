import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleIssueRefCard } from "./issue-ref-card.js";
import type { HandlerContext } from "./types.js";
import type { WsIssueRefCard } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const event = (over: Partial<WsIssueRefCard["card"]> = {}): WsIssueRefCard => ({
  type: "issue_ref_card",
  sessionId: "s1",
  card: {
    cardId: "ref-1",
    tracker: "github",
    identifier: "octocat/hello#42",
    title: "An open issue",
    url: "https://github.com/octocat/hello/issues/42",
    status: "Open",
    statusType: "started",
    createdAt: "2026-06-03T00:00:00.000Z",
    ...over,
  },
});

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

describe("handleIssueRefCard (docs/188)", () => {
  it("appends a marker message carrying the full payload", () => {
    handleIssueRefCard(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      issueRef: { cardId: "ref-1", identifier: "octocat/hello#42", title: "An open issue" },
    });
  });

  it("is idempotent by cardId — a reconnect replay appends once", () => {
    handleIssueRefCard(ctx, event());
    handleIssueRefCard(ctx, event()); // same cardId (history load + buffer replay)
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("does not duplicate when the marker already came from persisted history", () => {
    useSessionStore.setState({
      messages: [{ role: "assistant", text: "", issueRef: event().card }],
    });
    handleIssueRefCard(ctx, event());
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
