import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../stores/session-store.js";
import { getReturnedMessageIds, getSavedDraftMessage, saveDraftMessage } from "./local-storage.js";
import { offerReturnedMessages, prependReturnedText, takeReturnedIntoDraft } from "./returned-messages.js";

beforeEach(() => {
  localStorage.clear();
  useSessionStore.getState().reset();
  useSessionStore.setState({ sessionId: "A", queuedMessages: [] });
});

describe("the text of the returned messages goes before the draft (docs/330 req 1)", () => {
  it("puts a blank line between the returned text and what the user was writing", () => {
    expect(prependReturnedText("my draft", "first\n\nsecond")).toBe("first\n\nsecond\n\nmy draft");
  });

  it("is the returned text alone when the input box is empty", () => {
    expect(prependReturnedText("  \n", "first")).toBe("first");
  });

  it("changes nothing when no text returned", () => {
    expect(prependReturnedText("my draft", "")).toBe("my draft");
  });
});

describe("takeReturnedIntoDraft", () => {
  const messages = [
    { id: "m1", text: "first", files: [{ path: "src/a.ts" }] },
    { id: "m2", text: "second", files: [{ path: "/uploads/shot.png" }] },
  ];

  it("saves the messages into the session's draft, in order, before it answers", () => {
    saveDraftMessage("A", "my draft");

    const returned = takeReturnedIntoDraft("A", "A", messages);

    expect(getSavedDraftMessage("A")).toBe("first\n\nsecond\n\nmy draft");
    expect(returned).toEqual({
      text: "first\n\nsecond",
      files: ["src/a.ts", "/uploads/shot.png"],
      ids: ["m1", "m2"],
    });
    expect(getReturnedMessageIds("A")).toEqual(["m1", "m2"]);
  });

  it("adds nothing when the same list arrives a second time, and still names its ids", () => {
    takeReturnedIntoDraft("A", "A", messages);

    const again = takeReturnedIntoDraft("A", "A", messages);

    expect(again).toEqual({ text: "", files: [], ids: ["m1", "m2"] });
    expect(getSavedDraftMessage("A")).toBe("first\n\nsecond");
  });

  it("adds only the message that is new in a longer list", () => {
    takeReturnedIntoDraft("A", "A", [messages[0]]);

    const next = takeReturnedIntoDraft("A", "A", messages);

    expect(next.text).toBe("second");
    expect(getSavedDraftMessage("A")).toBe("second\n\nfirst");
  });

  it("keeps the record per session", () => {
    takeReturnedIntoDraft("A", "A", messages);

    expect(takeReturnedIntoDraft("B", "B", messages).text).toBe("first\n\nsecond");
  });
});

describe("offerReturnedMessages", () => {
  it("hands the list to the composer with the session it belongs to", () => {
    offerReturnedMessages("A", [{ id: "m1", text: "first" }]);

    expect(useSessionStore.getState().returnedToComposer).toEqual({
      sessionId: "A",
      messages: [{ id: "m1", text: "first" }],
    });
  });

  it("removes the row that this browser predicted for a returned message", () => {
    useSessionStore.setState({
      queuedMessages: [
        { text: "first", position: 1, requestId: "m1" },
        { text: "sent later", position: 2, requestId: "m9" },
      ],
    });

    offerReturnedMessages("A", [{ id: "m1", text: "first" }]);

    expect(useSessionStore.getState().queuedMessages).toEqual([
      { text: "sent later", position: 1, requestId: "m9" },
    ]);
  });

  it("offers nothing for an empty list", () => {
    offerReturnedMessages("A", []);
    expect(useSessionStore.getState().returnedToComposer).toBeUndefined();
  });
});
