import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ActionChecklistCard } from "./ActionChecklistCard.js";
import { useSessionStore } from "../stores/session-store.js";
import type { ActionChecklistCard as ActionChecklistCardData } from "../../server/shared/types.js";

/**
 * Tests for the interactive `ActionChecklistCard` (docs/207 / SHI-153). The card
 * renders straight from its props (no store, no lifecycle). Submit produces ONE
 * message from the selected payloads; Add comment seeds the main composer with a
 * snapshot of the SELECTED actions only. The post-submit ack is transient
 * client-only state.
 */

function card(over: Partial<ActionChecklistCardData> = {}): ActionChecklistCardData {
  return {
    cardId: "ac-1",
    title: "Optional follow-ups",
    actions: [
      { id: "a1", label: "Open a PR", description: "From the current branch", payload: "Open a PR for this change." },
      { id: "a2", label: "Update docs", payload: "Update the API docs for the new route." },
      { id: "a3", label: "File issue", defaultChecked: true, payload: "File a follow-up issue for the rate-limit case." },
    ],
    branch: "shipit/apobab",
    headSha: "abc12345",
    createdAt: "2026-06-15T11:34:00.000Z",
    ...over,
  };
}

const single = (): ActionChecklistCardData =>
  card({ actions: [{ id: "only", label: "Open a PR", payload: "Open a PR for this change." }] });

beforeEach(() => {
  useSessionStore.setState({ prefillText: undefined });
});
afterEach(() => cleanup());

describe("ActionChecklistCard — single action", () => {
  it("renders one action with a 'Do it' button and no checkboxes", () => {
    render(<ActionChecklistCard card={single()} />);
    expect(screen.getByRole("button", { name: /Do it/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add comment/ })).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("Do it submits the lone action's payload with provenance", () => {
    const onSubmit = vi.fn<(text: string) => boolean>(() => true);
    render(<ActionChecklistCard card={single()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /Do it/ }));
    const msg = onSubmit.mock.calls[0][0] as string;
    expect(msg).toContain("Open a PR for this change.");
    expect(msg).toContain("shipit/apobab");
  });
});

describe("ActionChecklistCard — multi action", () => {
  it("pre-ticks defaultChecked actions and disables Submit only when nothing is selected", () => {
    render(<ActionChecklistCard card={card({ actions: card().actions.map((a) => ({ ...a, defaultChecked: false })) })} />);
    // none checked → Submit disabled
    expect(screen.getByRole("button", { name: /Submit/ })).toBeDisabled();
    // Add comment never disabled
    expect(screen.getByRole("button", { name: /Add comment/ })).toBeEnabled();
  });

  it("starts with the recommended (defaultChecked) action selected", () => {
    render(<ActionChecklistCard card={card()} />);
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(3);
    // a3 is defaultChecked
    expect((checkboxes[2] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: /Submit 1 action/ })).toBeEnabled();
  });

  it("submits only the ticked payloads (not labels) as one message, then shows a transient ack and clears boxes", () => {
    const onSubmit = vi.fn<(text: string) => boolean>(() => true);
    render(<ActionChecklistCard card={card()} onSubmit={onSubmit} />);
    // tick a1 in addition to the default a3
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Submit 2 actions/ }));

    const msg = onSubmit.mock.calls[0][0] as string;
    expect(msg).toContain("Open a PR for this change.");
    expect(msg).toContain("File a follow-up issue for the rate-limit case.");
    expect(msg).not.toContain("Update the API docs"); // a2 not ticked

    // transient ack + boxes cleared
    expect(screen.getByText(/Submitted · 2 actions sent/)).toBeInTheDocument();
    for (const cb of screen.getAllByRole("checkbox")) {
      expect((cb as HTMLInputElement).checked).toBe(false);
    }
    expect(screen.getByRole("button", { name: /^Submit$/ })).toBeDisabled();
  });

  it("Add comment seeds the composer with ONLY the selected payloads as bullets and never sends", () => {
    const onSubmit = vi.fn<(text: string) => boolean>(() => true);
    render(<ActionChecklistCard card={card()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /Add comment/ }));

    expect(onSubmit).not.toHaveBeenCalled();
    const seeded = useSessionStore.getState().prefillText ?? "";
    expect(seeded).toContain("Re: Optional follow-ups");
    // only default-checked a3 is seeded, as a bullet; the unticked ones are absent
    expect(seeded).toContain("- File a follow-up issue for the rate-limit case.");
    expect(seeded).not.toContain("Open a PR for this change.");
    expect(seeded).not.toContain("[x]");
    expect(seeded).not.toContain("[ ]");
  });
});

/**
 * The ack must never outrun the wire. `onSubmit` reports whether the message was
 * actually accepted for delivery (see `sendUserMessage` / `useWebSocket.send`,
 * which drops silently on a non-OPEN socket); a `false` must leave the user's
 * selection — including the RECOMMENDED defaults — exactly as it was so a retry
 * is one click, not a re-tick. Reported by an operator: "I've sent a response
 * from the card but it didn't do anything. 'Recommended' options were cleared."
 */
describe("ActionChecklistCard — ack is conditional on delivery", () => {
  it("does not ack and does not clear the selection when the send never reaches the wire", () => {
    const onSubmit = vi.fn<(text: string) => boolean>(() => false);
    render(<ActionChecklistCard card={card()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]); // a1 + default a3
    fireEvent.click(screen.getByRole("button", { name: /Submit 2 actions/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Submitted/)).not.toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes[0].checked).toBe(true);
    expect(boxes[2].checked).toBe(true);
    // The RECOMMENDED badge survives — it is what the operator saw disappear.
    expect(screen.getByText("RECOMMENDED")).toBeInTheDocument();
  });

  it("surfaces the failure and stays retryable — no lock, no terminal state", () => {
    const onSubmit = vi.fn<(text: string) => boolean>(() => false);
    render(<ActionChecklistCard card={card()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /Submit 1 action/ }));

    expect(screen.getByText(/Couldn't send/)).toBeInTheDocument();
    // Same selection, same live button: pressing again re-sends the same subset.
    const retry = screen.getByRole("button", { name: /Submit 1 action/ });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1][0]).toEqual(onSubmit.mock.calls[0][0]);
  });

  it("acks once delivery succeeds after an earlier drop, and drops the failure notice", () => {
    const onSubmit = vi.fn<(text: string) => boolean>();
    onSubmit.mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ActionChecklistCard card={card()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /Submit 1 action/ }));
    expect(screen.getByText(/Couldn't send/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Submit 1 action/ }));
    expect(screen.queryByText(/Couldn't send/)).not.toBeInTheDocument();
    expect(screen.getByText(/Submitted · 1 action sent/)).toBeInTheDocument();
    for (const cb of screen.getAllByRole("checkbox")) {
      expect((cb as HTMLInputElement).checked).toBe(false);
    }
  });

  it("does not ack when no sender is wired at all — nothing was sent", () => {
    render(<ActionChecklistCard card={single()} />);
    fireEvent.click(screen.getByRole("button", { name: /Do it/ }));

    expect(screen.queryByText(/Submitted/)).not.toBeInTheDocument();
    expect(screen.getByText(/Couldn't send/)).toBeInTheDocument();
  });
});
