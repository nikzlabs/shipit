/**
 * docs/330-stop-returns-queued-messages — the input box takes the messages that a Stop took
 * out of the queue, and only then tells the server.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { MessageInput } from "./MessageInput.js";
import { useSessionStore } from "../stores/session-store.js";
import { getSavedDraftMessage } from "../utils/local-storage.js";

const PLACEHOLDER = "Describe what to build... (type @ to attach files)";

const returned = [
  { id: "m1", text: "first", files: [{ path: "src/a.ts" }] },
  { id: "m2", text: "second", files: [{ path: "/uploads/shot.png" }] },
];

function renderComposer(props: Partial<Parameters<typeof MessageInput>[0]> = {}) {
  const onAddFile = vi.fn();
  const onReturnedTaken = vi.fn();
  render(
    <MessageInput
      onSend={vi.fn().mockReturnValue(true)}
      disabled={false}
      sessionId="A"
      focusKey="A"
      onAddFile={onAddFile}
      onReturnedTaken={onReturnedTaken}
      {...props}
    />,
  );
  return { onAddFile, onReturnedTaken, textarea: () => screen.getByPlaceholderText<HTMLTextAreaElement>(PLACEHOLDER) };
}

const offer = (sessionId: string) =>
  act(() => { useSessionStore.getState().setReturnedToComposer({ sessionId, messages: returned }); });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSessionStore.getState().reset();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(cleanup);

describe("the input box takes the messages that a Stop returned", () => {
  it("puts them before the text that is there, with their files, and then answers the server", () => {
    const { onAddFile, onReturnedTaken, textarea } = renderComposer();
    fireEvent.change(textarea(), { target: { value: "my draft" } });
    // The answer lets the server forget the messages, so the draft must hold them already.
    let savedAtAnswer: string | undefined;
    onReturnedTaken.mockImplementation(() => { savedAtAnswer = getSavedDraftMessage("A"); });

    offer("A");

    expect(savedAtAnswer).toBe("first\n\nsecond\n\nmy draft");

    expect(textarea().value).toBe("first\n\nsecond\n\nmy draft");
    expect(getSavedDraftMessage("A")).toBe("first\n\nsecond\n\nmy draft");
    expect(onAddFile.mock.calls.map((c) => c[0])).toEqual(["src/a.ts", "/uploads/shot.png"]);
    expect(onReturnedTaken).toHaveBeenCalledWith(["m1", "m2"]);
    expect(useSessionStore.getState().returnedToComposer).toBeUndefined();
  });

  it("takes a list that waited for the composer to mount", () => {
    useSessionStore.getState().setReturnedToComposer({ sessionId: "A", messages: returned });

    const { onReturnedTaken, textarea } = renderComposer();

    expect(textarea().value).toBe("first\n\nsecond");
    expect(onReturnedTaken).toHaveBeenCalledWith(["m1", "m2"]);
  });

  it("answers again and adds nothing when the same list arrives a second time", () => {
    const { onAddFile, onReturnedTaken, textarea } = renderComposer();

    offer("A");
    offer("A");

    expect(textarea().value).toBe("first\n\nsecond");
    expect(onAddFile).toHaveBeenCalledTimes(2);
    expect(onReturnedTaken).toHaveBeenCalledTimes(2);
  });

  it("leaves the messages of another session alone, and does not answer for them", () => {
    const { onAddFile, onReturnedTaken, textarea } = renderComposer();

    offer("B");

    expect(textarea().value).toBe("");
    expect(onAddFile).not.toHaveBeenCalled();
    expect(onReturnedTaken).not.toHaveBeenCalled();
    expect(useSessionStore.getState().returnedToComposer?.sessionId).toBe("B");
  });

  it("takes a later message after the earlier one, in the order they were sent", () => {
    const { textarea } = renderComposer();
    fireEvent.change(textarea(), { target: { value: "my draft" } });

    act(() => { useSessionStore.getState().setReturnedToComposer({ sessionId: "A", messages: [returned[0]] }); });
    act(() => { useSessionStore.getState().setReturnedToComposer({ sessionId: "A", messages: [returned[1]] }); });

    expect(textarea().value).toBe("first\n\nsecond\n\nmy draft");
    expect(getSavedDraftMessage("A")).toBe("first\n\nsecond\n\nmy draft");
  });

  it("is not taken by the quick-capture composer", () => {
    const { onReturnedTaken } = renderComposer({ surface: "overlay" });

    offer("A");

    expect(onReturnedTaken).not.toHaveBeenCalled();
    expect(useSessionStore.getState().returnedToComposer?.sessionId).toBe("A");
  });
});
