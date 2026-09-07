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
import { usePrStore } from "../stores/pr-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
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
    render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
    type("look at this");
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAttribute("title", expect.stringContaining("finish uploading"));
  });

  it("refuses on Enter too, not only on the button", () => {
    // The button and `handleSubmit` used to carry separate copies of the guard,
    // and Enter reaches only the second one.
    const onSend = vi.fn().mockReturnValue(true);
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
    render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
    type("look at this");
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAttribute("title", expect.stringContaining("retry or remove"));
  });

  it("sends once the attachment is ready", () => {
    // Non-vacuous control for the two refusals above.
    const onSend = vi.fn().mockReturnValue(true);
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
    const onSend = vi.fn().mockReturnValue(true);
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
    const onSend = vi.fn().mockReturnValue(true);
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
    const onSend = vi.fn().mockReturnValue(true);
    render(<MessageInput onSend={onSend} disabled={false} />);
    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(screen.getByPlaceholderText(PLACEHOLDER), { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("still refuses whitespace-only text with no attachments", () => {
    const onSend = vi.fn().mockReturnValue(true);
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
    const onSend = vi.fn().mockReturnValue(true);
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
    render(<MessageInput surface="overlay" onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
    expect(screen.getByTestId("send-button")).toBeDisabled();
  });
});

describe("/compact is a command, not a message (docs/294 reqs 5-6)", () => {
  it("keeps the attachment in the composer and sends none with it", () => {
    // The mid-turn path discards attachments server-side, so they vanished with
    // no error. `/compact` asks the agent to summarise the conversation; it has
    // no use for a file.
    const onSend = vi.fn().mockReturnValue(true);
    seedUpload({ status: "ready" });
    render(<MessageInput onSend={onSend} disabled={false} />);
    type("/compact");
    fireEvent.click(sendButton());

    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/compact", uploadRefs: [], uploads: [] }),
    );
    // req 5 — still attached, ready for the next real message.
    expect(useFileStore.getState().sessionUploads[0].pending).toBe(true);
  });

  it("keeps it for `/compact <instructions>` too", () => {
    // The arg form is the same command; a prefix-only check would treat it as
    // an ordinary message and clear the chips.
    const onSend = vi.fn().mockReturnValue(true);
    seedUpload({ status: "ready" });
    render(<MessageInput onSend={onSend} disabled={false} />);
    type("/compact keep the design decisions");
    fireEvent.click(sendButton());

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ uploadRefs: [] }));
    expect(useFileStore.getState().sessionUploads[0].pending).toBe(true);
  });

  it("does not mistake an ordinary message for the command", () => {
    // Non-vacuous control: `/compactfoo` is not `/compact`, and a real message
    // must still carry and clear its attachment.
    const onSend = vi.fn().mockReturnValue(true);
    seedUpload({ status: "ready" });
    render(<MessageInput onSend={onSend} disabled={false} />);
    type("/compactfoo");
    fireEvent.click(sendButton());

    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadRefs: [{ path: "/uploads/notes.txt", type: "upload" }],
      }),
    );
    expect(useFileStore.getState().sessionUploads[0].pending).toBe(false);
  });
});

describe("/compact on the quick-capture overlay (docs/294 reqs 5-6)", () => {
  it("is refused, so the attachment neither travels nor is destroyed", () => {
    // Reqs 5 and 6 want the attachment kept in the composer and no attachment
    // sent. This surface unmounts its composer on send, so a message that GOES
    // cannot satisfy both — and a brand-new session has nothing to compact.
    // Refusing the send is what makes both requirements true here.
    const onSend = vi.fn().mockReturnValue(true);
    render(<MessageInput surface="overlay" onSend={onSend} disabled={false} />);
    const textarea = screen.getByRole("textbox");
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { items: [], getData: () => "x".repeat(5000) },
    });
    fireEvent(textarea, ev);
    fireEvent.change(textarea, { target: { value: "/compact" } });

    const send = screen.getByTestId("send-button");
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", expect.stringContaining("nothing to compact"));
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("still sends an ordinary overlay message with its attachment", () => {
    // Non-vacuous control: the bar is for the command, not for the surface.
    const onSend = vi.fn().mockReturnValue(true);
    render(<MessageInput surface="overlay" onSend={onSend} disabled={false} />);
    const textarea = screen.getByRole("textbox");
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { items: [], getData: () => "x".repeat(5000) },
    });
    fireEvent(textarea, ev);
    fireEvent.change(textarea, { target: { value: "build me a thing" } });

    expect(screen.getByTestId("send-button")).toBeEnabled();
    fireEvent.click(screen.getByTestId("send-button"));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ deferredFiles: [expect.any(File)] }),
    );
  });
});

describe("A refused send keeps what it would have sent (docs/293 req 4)", () => {
  // `App.handleSend` turns a `/review` away on three paths — no session, a turn
  // already running, no target file — and shows a toast about the refusal. The
  // composer cleared regardless, so the text AND the attachment went with a
  // message that was never sent, and the toast said nothing about that.
  beforeEach(() => {
    usePrStore.setState({ resetEligibleBySession: {} });
    useSettingsStore.setState({ autoResetMergedBranch: true });
  });

  it("keeps the text and the attachment when the parent returns false", () => {
    seedUpload({ status: "ready" });
    render(<MessageInput onSend={() => false} disabled={false} />);
    type("/review");
    fireEvent.click(sendButton());

    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue("/review");
    expect(useFileStore.getState().sessionUploads[0].pending).toBe(true);
  });

  it("clears them when the parent accepts", () => {
    // Non-vacuous control for the refusal above.
    seedUpload({ status: "ready" });
    render(<MessageInput onSend={() => true} disabled={false} />);
    type("/review");
    fireEvent.click(sendButton());

    expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue("");
    expect(useFileStore.getState().sessionUploads[0].pending).toBe(false);
  });

  it("keeps the reset-to-base control up on a refused send", () => {
    // The optimistic clear runs on the way out because the turn is about to
    // reset the branch. A refused send starts no turn, so hiding the control
    // would leave the user unable to opt in until the server recomputed —
    // which, with no turn, it never would.
    usePrStore.setState({ resetEligibleBySession: { s1: true } });
    render(<MessageInput onSend={() => false} disabled={false} sessionId="s1" />);
    expect(screen.getByTestId("reset-merged-branch-control")).toBeInTheDocument();
    type("/review");
    fireEvent.click(sendButton());

    expect(screen.getByTestId("reset-merged-branch-control")).toBeInTheDocument();
  });

  it("still clears it once the send is accepted", () => {
    // Non-vacuous control for the one above: the optimistic clear still runs,
    // it just runs on the accepted path now. The store drops the key rather
    // than storing `false` — absence is how it spells ineligible.
    usePrStore.setState({ resetEligibleBySession: { s1: true } });
    render(<MessageInput onSend={() => true} disabled={false} sessionId="s1" />);
    type("/review");
    fireEvent.click(sendButton());

    expect(screen.queryByTestId("reset-merged-branch-control")).not.toBeInTheDocument();
  });
});
