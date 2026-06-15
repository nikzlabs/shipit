import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ActionChecklistCard } from "./ActionChecklistCard.js";
import { useSessionStore } from "../stores/session-store.js";
import type { ActionChecklistCard as ActionChecklistCardData } from "../../server/shared/types.js";

/**
 * Tests for the interactive `ActionChecklistCard` (docs/207 / SHI-153). The card
 * renders straight from its props (no store, no lifecycle). Submit produces ONE
 * message from the selected payloads; Add comment seeds the main composer with a
 * whole-menu snapshot. The post-submit ack is transient client-only state.
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
    const onSubmit = vi.fn();
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
    const onSubmit = vi.fn();
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

  it("Add comment seeds the composer with the whole-menu [x]/[ ] payload snapshot and never sends", () => {
    const onSubmit = vi.fn();
    render(<ActionChecklistCard card={card()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /Add comment/ }));

    expect(onSubmit).not.toHaveBeenCalled();
    const seeded = useSessionStore.getState().prefillText ?? "";
    expect(seeded).toContain("Re: Optional follow-ups");
    // default-checked a3 is [x]; others [ ]; uses payloads
    expect(seeded).toContain("[x] File a follow-up issue for the rate-limit case.");
    expect(seeded).toContain("[ ] Open a PR for this change.");
  });
});
