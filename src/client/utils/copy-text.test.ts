import { describe, it, expect, afterEach, vi } from "vitest";
import { copyText } from "./copy-text.js";

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

/**
 * jsdom has no `execCommand`. The stub records what was selected when "copy" ran and, like a
 * browser, fires a `copy` event at the selection.
 */
function stubExecCommand(result: boolean | (() => boolean) = true) {
  const selectedAtCopy: string[] = [];
  const setData = vi.fn();
  const copyEvents: Event[] = [];
  const execCommand = vi.fn((command: string) => {
    if (command === "copy") {
      const selection = document.getSelection();
      selectedAtCopy.push(selection?.toString() ?? "");
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { setData } });
      copyEvents.push(event);
      selection?.anchorNode?.dispatchEvent(event);
    }
    return typeof result === "function" ? result() : result;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  return { execCommand, selectedAtCopy, setData, copyEvents };
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(navigator, "clipboard");
  document.body.innerHTML = "";
  document.getSelection()?.removeAllRanges();
});

describe("copyText", () => {
  it("uses the Clipboard API when it is available", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    const { execCommand } = stubExecCommand();

    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("copies through a selection when the Clipboard API is absent (plain-HTTP origin)", async () => {
    setClipboard(undefined);
    const { execCommand, selectedAtCopy } = stubExecCommand();

    expect(await copyText("line one\n  line two")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(selectedAtCopy).toEqual(["line one\n  line two"]);
    expect(document.body.children).toHaveLength(0);
  });

  it("puts plain text only on the clipboard, not the helper element's HTML", async () => {
    setClipboard(undefined);
    const { setData, copyEvents } = stubExecCommand();
    const pageListener = vi.fn();
    document.addEventListener("copy", pageListener);

    try {
      await copyText("<b>raw</b>");

      expect(setData.mock.calls).toEqual([["text/plain", "<b>raw</b>"]]);
      expect(copyEvents[0].defaultPrevented).toBe(true);
      expect(pageListener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("copy", pageListener);
    }
  });

  it("runs the selection copy before any await, inside the click's user activation", () => {
    setClipboard(undefined);
    const { execCommand } = stubExecCommand();

    void copyText("sync");

    expect(execCommand).toHaveBeenCalledTimes(1);
  });

  it("falls back to the selection when the Clipboard API rejects", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.reject(new Error("denied"))) });
    const { selectedAtCopy } = stubExecCommand();

    expect(await copyText("after rejection")).toBe(true);
    expect(selectedAtCopy).toEqual(["after rejection"]);
  });

  it("restores the selection the user had", async () => {
    setClipboard(undefined);
    stubExecCommand();
    const p = document.createElement("p");
    p.textContent = "selected by the user";
    document.body.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    document.getSelection()?.addRange(range);

    await copyText("something else");

    expect(document.getSelection()?.toString()).toBe("selected by the user");
  });

  it("restores a backwards selection with its direction", async () => {
    setClipboard(undefined);
    stubExecCommand();
    const p = document.createElement("p");
    p.textContent = "selected backwards";
    document.body.appendChild(p);
    const text = p.firstChild!;
    document.getSelection()?.setBaseAndExtent(text, 12, text, 0);

    await copyText("something else");

    const selection = document.getSelection()!;
    expect([selection.anchorOffset, selection.focusOffset]).toEqual([12, 0]);
    expect(selection.toString()).toBe("selected bac");
  });

  it("reports failure when neither path can copy", async () => {
    setClipboard(undefined);
    stubExecCommand(false);
    expect(await copyText("x")).toBe(false);

    stubExecCommand(() => {
      throw new Error("blocked");
    });
    expect(await copyText("x")).toBe(false);
    expect(document.body.children).toHaveLength(0);
  });
});
