/**
 * docs/293-send-with-attachments — what Send does about attachments.
 *
 * Seeds the file store directly so a chip can be held in each upload status;
 * the chat surface reads pending uploads straight out of that store.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MessageInput } from "./MessageInput.js";
import { useFileStore } from "../stores/file-store.js";
import type { UploadItem } from "../../server/shared/types.js";

afterEach(cleanup);

beforeEach(() => {
  useFileStore.setState({ sessionUploads: [] });
});

function seedUpload(patch: Partial<UploadItem> & Pick<UploadItem, "status">) {
  const item: UploadItem = {
    id: `u-${patch.status}`,
    name: "notes.txt",
    size: 10,
    progress: patch.status === "ready" ? 100 : 0,
    pending: true,
    ...(patch.status === "ready" ? { path: "/uploads/notes.txt" } : {}),
    ...patch,
  };
  useFileStore.setState({ sessionUploads: [item] });
}

const PLACEHOLDER = "Describe what to build... (type @ to attach files)";

function type(value: string) {
  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value } });
}

function sendButton() {
  return screen.getByTestId("send-button");
}

describe("Send never loses an attachment", () => {
  it("refuses while an attachment is still uploading, and says why", () => {
    // req 1. Today's behaviour was to send happily and drop the attachment.
    seedUpload({ status: "uploading" });
    render(<MessageInput onSend={vi.fn()} disabled={false} />);
    type("look at this");
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAttribute("title", expect.stringContaining("finish uploading"));
  });

  it("refuses on Enter too, not only on the button", () => {
    // The button and `handleSubmit` used to carry separate copies of the guard,
    // and Enter reaches only the second one.
    const onSend = vi.fn();
    seedUpload({ status: "uploading" });
    render(<MessageInput onSend={onSend} disabled={false} />);
    type("look at this");
    fireEvent.keyDown(screen.getByPlaceholderText(PLACEHOLDER), { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("refuses while an attachment has failed, and says why", () => {
    // req 2 — the user's choice: a failed attachment holds the message rather
    // than being left behind.
    seedUpload({ status: "error", error: "Upload failed" });
    render(<MessageInput onSend={vi.fn()} disabled={false} />);
    type("look at this");
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAttribute("title", expect.stringContaining("retry or remove"));
  });

  it("sends once the attachment is ready", () => {
    // Non-vacuous control for the two refusals above.
    const onSend = vi.fn();
    seedUpload({ status: "ready" });
    render(<MessageInput onSend={onSend} disabled={false} />);
    type("look at this");
    expect(sendButton()).toBeEnabled();
    expect(sendButton()).not.toHaveAttribute("title");
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "look at this",
        uploadRefs: [{ path: "/uploads/notes.txt", type: "upload" }],
      }),
    );
  });
});

describe("Send carries attachments alone", () => {
  it("sends a ready attachment with no typed text", () => {
    // req 5. Before this, a large paste emptied the composer and Enter did
    // nothing at all.
    const onSend = vi.fn();
    seedUpload({ status: "ready" });
    render(<MessageInput onSend={onSend} disabled={false} />);
    expect(sendButton()).toBeEnabled();
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        uploadRefs: [{ path: "/uploads/notes.txt", type: "upload" }],
      }),
    );
  });

  it("sends an @-mentioned file with no typed text", () => {
    // req 5 covers every attachment kind, not just uploads.
    const onSend = vi.fn();
    render(
      <MessageInput
        onSend={onSend}
        disabled={false}
        pendingFiles={[{ path: "src/index.ts" }]}
        onRemoveFile={vi.fn()}
      />,
    );
    expect(sendButton()).toBeEnabled();
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
  });

  it("still refuses a message with neither text nor attachments", () => {
    // req 6 — the bound on req 5.
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} disabled={false} />);
    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(screen.getByPlaceholderText(PLACEHOLDER), { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("still refuses whitespace-only text with no attachments", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} disabled={false} />);
    type("   \n  ");
    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(screen.getByPlaceholderText(PLACEHOLDER), { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("The gate holds on the overlay surface too", () => {
  it("sends a locally-buffered attachment with no typed text", () => {
    // The quick-capture overlay buffers Files locally instead of POSTing, so it
    // reaches `sendBlocked` through a different backend. req 5 has to hold here
    // as well — this is the surface whose server side rejected it.
    const onSend = vi.fn();
    render(<MessageInput surface="overlay" onSend={onSend} disabled={false} />);
    const textarea = screen.getByRole("textbox");
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { items: [], getData: () => "x".repeat(5000) },
    });
    fireEvent(textarea, ev);

    expect(screen.getByTestId("send-button")).toBeEnabled();
    fireEvent.click(screen.getByTestId("send-button"));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: "", deferredFiles: [expect.any(File)] }),
    );
  });

  it("still refuses an empty overlay composer", () => {
    render(<MessageInput surface="overlay" onSend={vi.fn()} disabled={false} />);
    expect(screen.getByTestId("send-button")).toBeDisabled();
  });
});
