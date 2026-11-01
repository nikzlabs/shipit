import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../stores/session-store.js";
import { offerReturnedMessages, placeReturnedText, takeReturnedMessages } from "./returned-messages.js";

beforeEach(() => {
  sessionStorage.clear();
  useSessionStore.getState().reset();
  useSessionStore.setState({ sessionId: "A", queuedMessages: [], messages: [] });
});

describe("the returned text goes before the draft (docs/330 req 1)", () => {
  it("puts a blank line between the returned text and what the user was writing", () => {
    expect(placeReturnedText("my draft", "first\n\nsecond", "")).toEqual({
      text: "first\n\nsecond\n\nmy draft",
      block: "first\n\nsecond",
    });
  });

  it("is the returned text alone when the input box is empty", () => {
    expect(placeReturnedText("  \n", "first", "").text).toBe("first");
  });

  it("goes after returned text that is still at the head, so the send order holds", () => {
    expect(placeReturnedText("first\n\nmy draft", "second", "first")).toEqual({
      text: "first\n\nsecond\n\nmy draft",
      block: "first\n\nsecond",
    });
  });

  it("goes to the head when the user changed the returned text", () => {
    expect(placeReturnedText("edited\n\nmy draft", "second", "first").text).toBe("second\n\nedited\n\nmy draft");
  });
});

describe("takeReturnedMessages", () => {
  const messages = [
    { id: "m1", text: "first", files: [{ path: "src/a.ts" }] },
    { id: "m2", text: "second", files: [{ path: "/uploads/shot.png" }] },
  ];

  it("gives the new text, the files, and every id to answer", () => {
    expect(takeReturnedMessages("A", messages, "my draft")).toEqual({
      text: "first\n\nsecond\n\nmy draft",
      files: ["src/a.ts", "/uploads/shot.png"],
      ids: ["m1", "m2"],
    });
  });

  it("adds nothing when the same list arrives a second time, and still names its ids", () => {
    const first = takeReturnedMessages("A", messages, "");

    expect(takeReturnedMessages("A", messages, first.text ?? "")).toEqual({ text: null, files: [], ids: ["m1", "m2"] });
  });

  it("keeps the send order when a later message returns in a second list", () => {
    const first = takeReturnedMessages("A", [messages[0]], "my draft");

    const second = takeReturnedMessages("A", [messages[1]], first.text ?? "");

    expect(second.text).toBe("first\n\nsecond\n\nmy draft");
  });

  it("forgets an id that the server no longer offers, however many there were", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, text: `message ${i}` }));
    const taken = takeReturnedMessages("A", many, "");

    // The answer was lost: the whole list comes again, and nothing is added a second time.
    expect(takeReturnedMessages("A", many, taken.text ?? "").text).toBeNull();
    // Answered: the server offers only a new one, and the record keeps only that one.
    takeReturnedMessages("A", [{ id: "new", text: "new" }], "");
    expect(JSON.parse(sessionStorage.getItem("shipit-returned:A") ?? "{}").ids).toEqual(["new"]);
  });

  it("keeps the record per session", () => {
    takeReturnedMessages("A", messages, "");

    expect(takeReturnedMessages("B", messages, "").text).toBe("first\n\nsecond");
  });

  // Per tab: a second tab of the same session puts the messages into its own input box.
  it("keeps the record in the tab, not in the browser", () => {
    takeReturnedMessages("A", messages, "");

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.getItem("shipit-returned:A")).not.toBeNull();
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

  // It was still on its way to the server at the Stop, so no queue row took its bubble.
  it("removes the bubble of a returned message from the transcript", () => {
    useSessionStore.setState({
      messages: [
        { role: "user", text: "ran", clientRequestId: "m0" },
        { role: "user", text: "first", clientRequestId: "m1" },
      ],
    });

    offerReturnedMessages("A", [{ id: "m1", text: "first" }]);

    expect(useSessionStore.getState().messages).toEqual([{ role: "user", text: "ran", clientRequestId: "m0" }]);
  });

  it("offers nothing for an empty list", () => {
    offerReturnedMessages("A", []);
    expect(useSessionStore.getState().returnedToComposer).toBeUndefined();
  });
});
